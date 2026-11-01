/*
 * Settings, sign-in, backend calls and the offline scan queue.
 * Scans are written to IndexedDB first and synced in batches of 20; a record leaves
 * the "pending" state only when the backend acknowledges it, so nothing is lost offline.
 */
(function (root) {
  'use strict';

  // ---------- settings ----------
  const SETTINGS_KEY = 'omr.settings';
  const defaults = { backendUrl: '', clientId: '', autoAccept: false, scanner: '' };
  const Settings = {
    get() { try { return Object.assign({}, defaults, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { return Object.assign({}, defaults); } },
    set(patch) { const s = Object.assign(Settings.get(), patch); localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); return s; },
    demo() { return !Settings.get().backendUrl; },
  };

  // ---------- Google sign-in (ID token) ----------
  const Auth = {
    token: null, email: null, exp: 0, listeners: [],
    restore() {
      try {
        const t = JSON.parse(sessionStorage.getItem('omr.auth') || 'null');
        if (t && t.exp > Date.now() / 1000 + 60) Object.assign(Auth, t);
      } catch (e) { /* ignore */ }
    },
    valid() { return !!Auth.token && Auth.exp > Date.now() / 1000 + 60; },
    accept(credential) {
      const payload = JSON.parse(atob(credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      Auth.token = credential; Auth.email = payload.email; Auth.exp = payload.exp;
      sessionStorage.setItem('omr.auth', JSON.stringify({ token: Auth.token, email: Auth.email, exp: Auth.exp }));
      Auth.listeners.forEach((f) => f());
    },
    signOut() {
      Auth.token = null; Auth.email = null; Auth.exp = 0;
      sessionStorage.removeItem('omr.auth');
      if (root.google && google.accounts) google.accounts.id.disableAutoSelect();
      Auth.listeners.forEach((f) => f());
    },
    init(buttonEl) {
      const id = Settings.get().clientId;
      if (!id || !root.google || !google.accounts) return false;
      google.accounts.id.initialize({ client_id: id, callback: (r) => Auth.accept(r.credential), auto_select: true });
      if (buttonEl) google.accounts.id.renderButton(buttonEl, { theme: 'outline', size: 'large', text: 'signin_with' });
      if (!Auth.valid()) google.accounts.id.prompt();
      return true;
    },
  };

  // ---------- backend ----------
  async function call(action, body) {
    const s = Settings.get();
    if (!s.backendUrl) throw new Error('No backend configured (demo mode)');
    if (!Auth.valid()) throw Object.assign(new Error('Please sign in again'), { auth: true });
    const res = await fetch(s.backendUrl, {
      method: 'POST',
      // text/plain keeps this a "simple" request: Apps Script does not answer CORS preflights
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action, idToken: Auth.token }, body || {})),
      redirect: 'follow',
    });
    if (!res.ok) throw Object.assign(new Error('Server error ' + res.status), { retry: true });
    const data = await res.json();
    if (!data.ok) throw Object.assign(new Error(data.error || 'Request failed'), { retry: !!data.retry, auth: !!data.auth });
    return data;
  }

  // ---------- course cache (roster, exams) ----------
  const Courses = {
    key: (paper) => 'omr.course.' + paper,
    get(paper) { try { return JSON.parse(localStorage.getItem(Courses.key(paper)) || 'null'); } catch (e) { return null; } },
    list() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith('omr.course.')) out.push(JSON.parse(localStorage.getItem(k)));
      }
      return out.sort((a, b) => a.paper.localeCompare(b.paper));
    },
    async load(paper) {
      const d = await call('bootstrap', { paper });
      const c = { paper, course: d.course, role: d.role, exams: d.exams, roster: d.roster, fetchedAt: Date.now() };
      localStorage.setItem(Courses.key(paper), JSON.stringify(c));
      return c;
    },
    async ensure(paper, maxAgeMs) {
      const c = Courses.get(paper);
      if (c && Date.now() - c.fetchedAt < (maxAgeMs || 6 * 3600e3)) return c;
      try { return await Courses.load(paper); } catch (e) { if (c) return c; throw e; }
    },
    remove(paper) { localStorage.removeItem(Courses.key(paper)); },
  };

  // ---------- IndexedDB scan queue ----------
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('omr', 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore('scans', { keyPath: 'scanId' });
        s.createIndex('status', 'status');
        s.createIndex('serialKey', 'serialKey');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('scans', mode);
      const out = fn(t.objectStore('scans'));
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    });
  }
  const Queue = {
    put: (rec) => tx('readwrite', (s) => s.put(rec)),
    get: (id) => tx('readonly', (s) => s.get(id)),
    all: () => tx('readonly', (s) => s.getAll()).then((a) => a.sort((x, y) => y.deviceTime.localeCompare(x.deviceTime))),
    bySerial: (serialKey) => tx('readonly', (s) => s.index('serialKey').getAll(serialKey)),
    pending: () => tx('readonly', (s) => s.index('status').getAll('pending')),
    remove: (id) => tx('readwrite', (s) => s.delete(id)),
    clearAll: () => tx('readwrite', (s) => s.clear()),
    async clearSynced() {
      const all = await Queue.all();
      for (const r of all) if (r.status === 'synced') await Queue.remove(r.scanId);
    },
  };

  // ---------- sync ----------
  const Sync = {
    running: false, listeners: [], lastError: null, backoff: 0, timer: null,
    notify() { Sync.listeners.forEach((f) => f()); },
    schedule(ms) { clearTimeout(Sync.timer); Sync.timer = setTimeout(Sync.run, ms); },
    async run() {
      if (Sync.running || Settings.demo() || !navigator.onLine) return;
      if (!Auth.valid()) { Sync.lastError = 'Sign in to sync'; Sync.notify(); return; }
      Sync.running = true; Sync.notify();
      try {
        let pending = await Queue.pending();
        while (pending.length) {
          const batch = pending.slice(0, 20);
          const payload = batch.map((r) => ({ scanId: r.scanId, qr: r.qr, enrollment: r.enrollment, answers: r.answers,
            uncertain: r.uncertain, corrections: r.corrections, deviceTime: r.deviceTime }));
          const d = await call('submitScans', { scans: payload });
          for (const o of d.results) {
            const r = batch.find((x) => x.scanId === o.scanId);
            if (!r) continue;
            r.status = o.outcome === 'error' ? 'pending' : 'synced';
            r.serverStatus = o.status || o.outcome;
            r.message = o.message || '';
            if (o.outcome === 'error') r.lastError = o.message;
            await Queue.put(r);
          }
          if (d.results.some((o) => o.outcome === 'error')) break; // leave failures for the next run
          pending = await Queue.pending();
        }
        Sync.lastError = null; Sync.backoff = 0;
      } catch (e) {
        Sync.lastError = e.message;
        if (e.retry !== false) {
          Sync.backoff = Math.min(60000, (Sync.backoff || 2000) * 2);
          Sync.schedule(Sync.backoff * (0.75 + Math.random() * 0.5)); // back off with jitter
        }
      } finally {
        Sync.running = false; Sync.notify();
      }
    },
  };
  root.addEventListener && root.addEventListener('online', () => Sync.run());

  root.OMRStore = { Settings, Auth, call, Courses, Queue, Sync };
})(self);
