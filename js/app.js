/* OMR scanner PWA — UI controller */
(function () {
  'use strict';
  const { Settings, Auth, call, Courses, Queue, Sync } = OMRStore;
  const $ = (id) => document.getElementById(id);
  const DISP = 4; // review canvas px per mm
  let cv = null;

  // ---------------- helpers ----------------
  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), ms || 2200);
  }
  function banner(msg, kind) { const b = $('banner'); b.textContent = msg || ''; b.className = 'banner ' + (kind || ''); b.hidden = !msg; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2); }
  function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* ignore */ } }

  // ---------------- views ----------------
  function show(view) {
    document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    if (view !== 'scan') stopCamera();
    if (view === 'history') renderHistory();
    if (view === 'print') renderPrint();
    if (view === 'settings') renderSettings();
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));

  // ---------------- OpenCV ----------------
  async function cvScriptLoaded() {
    let m = window.cv;
    if (m instanceof Promise) m = await m;          // newer builds export a real Promise
    // Older builds export the Emscripten Module, a "thenable" that resolves to itself:
    // awaiting it (or returning it from an async function) loops forever and freezes the page.
    // Wait for its ready hook instead, and never let it reach a Promise resolver.
    if (!m.Mat) {
      await new Promise((resolve) => {
        const done = () => { clearInterval(poll); resolve(); };
        const prev = m.onRuntimeInitialized;
        m.onRuntimeInitialized = () => { if (prev) prev(); done(); };
        const poll = setInterval(() => { if (m.Mat) done(); }, 100);  // in case it was already ready
      });
    }
    if (cv) return;                                   // called twice (onload + boot check)
    cv = m;
    $('cvLoading').hidden = true;
    if (!$('review').hidden || !$('camWrap').hidden) return;
    $('scanStart').hidden = false;
  }

  // ---------------- camera + auto-capture ----------------
  const cam = { stream: null, loop: null, busy: false, hist: [], sharpMax: 0, waitClear: false, count: 0, wake: null };
  const work = document.createElement('canvas');

  async function startCamera() {
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    } catch (e) { toast('Camera not available: ' + e.message, 4000); return; }
    const v = $('video');
    v.srcObject = cam.stream;
    await v.play();
    try { const track = cam.stream.getVideoTracks()[0]; const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* optional */ }
    try { cam.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
    $('scanStart').hidden = true; $('review').hidden = true; $('camWrap').hidden = false;
    cam.hist = []; cam.sharpMax = 0;
    cam.loop = setInterval(tick, 260);
  }
  function stopCamera() {
    clearInterval(cam.loop); cam.loop = null;
    if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
    cam.stream = null;
    if (cam.wake) { cam.wake.release().catch(() => {}); cam.wake = null; }
    $('camWrap').hidden = true;
    if ($('review').hidden && cv) $('scanStart').hidden = false;
  }
  function pauseCamera() { clearInterval(cam.loop); cam.loop = null; }
  function resumeCamera() { if (cam.stream && !cam.loop) { $('camWrap').hidden = false; cam.hist = []; cam.loop = setInterval(tick, 260); } else if (!cam.stream) startCamera(); }

  function frameData(maxDim) {
    const v = $('video');
    const s = Math.min(1, maxDim / Math.max(v.videoWidth, v.videoHeight));
    work.width = Math.round(v.videoWidth * s); work.height = Math.round(v.videoHeight * s);
    const ctx = work.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, work.width, work.height);
    return ctx.getImageData(0, 0, work.width, work.height);
  }

  function drawOverlay(corners, scale, good) {
    const v = $('video'), o = $('overlay');
    o.width = v.clientWidth; o.height = v.clientHeight;
    const ctx = o.getContext('2d');
    ctx.clearRect(0, 0, o.width, o.height);
    if (!corners) return;
    // video uses object-fit: contain
    const k = Math.min(o.width / v.videoWidth, o.height / v.videoHeight);
    const ox = (o.width - v.videoWidth * k) / 2, oy = (o.height - v.videoHeight * k) / 2;
    const P = corners.map(([x, y]) => [ox + (x / scale) * k, oy + (y / scale) * k]);
    ctx.lineWidth = 4; ctx.strokeStyle = good ? '#2a9d8f' : '#f4a261';
    ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
  }

  function tick() {
    if (cam.busy || !cv || !$('video').videoWidth) return;
    cam.busy = true;
    try {
      const img = frameData(960);
      const scale = img.width / $('video').videoWidth;
      const gray = OMRRecognize.rgbaToGray(cv, img);
      const det = OMRRecognize.detectMarkers(cv, gray, { detectMaxDim: 960 });
      const sharp = OMRRecognize.sharpness(cv, gray);
      gray.delete();
      if (det.error) {
        cam.hist = []; cam.waitClear = false;
        $('camHint').textContent = det.error;
        drawOverlay(null);
        return;
      }
      if (cam.waitClear) { $('camHint').textContent = 'Saved. Place the next sheet'; drawOverlay(det.corners, scale, false); return; }
      cam.sharpMax = Math.max(cam.sharpMax * 0.97, sharp);
      cam.hist.push(det.corners); if (cam.hist.length > 3) cam.hist.shift();
      const diag = Math.hypot(img.width, img.height);
      const steady = cam.hist.length === 3 && cam.hist.every((c) => c.every(([x, y], i) => Math.hypot(x - det.corners[i][0], y - det.corners[i][1]) < 0.012 * diag));
      const sharpOk = sharp >= 0.75 * cam.sharpMax && sharp > 15;
      drawOverlay(det.corners, scale, steady && sharpOk);
      $('camHint').textContent = !steady ? 'Hold steady…' : !sharpOk ? 'Focusing…' : 'Reading…';
      if (steady && sharpOk) capture();
    } catch (e) { console.error(e); } finally { cam.busy = false; }
  }

  function capture() {
    const v = $('video');
    const img = frameData(Math.max(v.videoWidth, v.videoHeight));
    processImage(img, true);
  }

  async function processImage(img, fromCamera) {
    let res;
    try { res = OMRRecognize.recognize(cv, jsQR, img); } catch (e) { console.error(e); res = { ok: false, error: 'Could not read this image' }; }
    if (!res.ok) {
      if (fromCamera) { $('camHint').textContent = res.error; cam.hist = []; } else toast(res.error, 4000);
      return;
    }
    vibrate(30);
    if (fromCamera) pauseCamera();
    await openReview(res);
  }

  $('btnStartCam').onclick = startCamera;
  $('btnStopCam').onclick = stopCamera;
  $('btnShutter').onclick = () => { if (cv && cam.stream) capture(); };
  $('filePhoto').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f || !cv) return;
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    const s = Math.min(1, 3200 / Math.max(bmp.width, bmp.height));
    work.width = Math.round(bmp.width * s); work.height = Math.round(bmp.height * s);
    const ctx = work.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, work.width, work.height);
    processImage(ctx.getImageData(0, 0, work.width, work.height), false);
  };

  // ---------------- review ----------------
  let R = null; // current review state

  async function openReview(res) {
    const qr = res.qr, L = res.layout;
    let course = Courses.get(qr.paper);
    if (!Settings.demo() && Auth.valid() && (!course || !course.exams || !course.exams[qr.exam])) {
      try { course = await Courses.load(qr.paper); } catch (e) { /* offline: continue without roster */ }
    }
    // display canvas: canonical image downscaled to DISP px/mm
    const disp = document.createElement('canvas');
    const full = document.createElement('canvas');
    cv.imshow(full, res.warped);
    res.warped.delete();
    disp.width = L.page.w * DISP; disp.height = L.page.h * DISP;
    disp.getContext('2d').drawImage(full, 0, 0, disp.width, disp.height);
    const thumb = document.createElement('canvas');
    thumb.width = L.page.w * 2; thumb.height = L.page.h * 2;
    thumb.getContext('2d').drawImage(full, 0, 0, thumb.width, thumb.height);

    R = {
      res, qr, L, course, disp,
      thumb: thumb.toDataURL('image/jpeg', 0.6),
      sel: res.items.map((it) => ({ orig: res.answers[it.q - 1], state: it.state, set: new Set(it.state === 'marked' ? [it.choice] : []), multi: it.state === 'multiple', fixed: false })),
      enrOrig: res.enrollment,
      corrections: [],
    };
    // multiple keeps the read bubbles that were above threshold so the instructor can see them
    res.items.forEach((it, i) => { if (it.state === 'multiple') it.adj.forEach((v, k) => { if (v >= OMRRecognize.DEFAULTS.fillT) R.sel[i].set.add(k); }); });

    const dups = await Queue.bySerial(qr.paper + '|' + qr.serial);
    R.dup = dups.length > 0;

    $('rvTitle').textContent = `${qr.paper} · ${qr.exam} · Set ${qr.set}`;
    const examName = course && course.exams && course.exams[qr.exam] ? course.exams[qr.exam].title : '';
    $('rvSub').textContent = `Sheet ${qr.serial} · ${qr.nq} questions${examName ? ' · ' + examName : ''}`;
    $('rvEnr').value = res.enrollment.split('').map((c) => (/\d/.test(c) ? c : '?')).join('');
    updateReview();

    const autoOk = Settings.get().autoAccept && !R.dup && res.uncertain === 0 && enrollmentStatus().ok && enrollmentStatus().onRoster !== false;
    if (autoOk && cam.stream) { await accept(true); return; }
    $('camWrap').hidden = true; $('scanStart').hidden = true; $('review').hidden = false;
    window.scrollTo(0, 0);
  }

  function rowChar(s) { return s.set.size === 0 ? '-' : s.set.size > 1 ? '*' : R.L.answers.options[[...s.set][0]]; }
  function answersString() {
    return R.sel.map((s) => (s.state === 'uncertain' && !s.fixed ? '?' : rowChar(s))).join('');
  }
  function enrollmentStatus() {
    const v = $('rvEnr').value.trim();
    const ok = /^\d{9}$/.test(v);
    const roster = R.course && R.course.roster;
    const hasRoster = roster && Object.keys(roster).length > 0;
    return { v, ok, onRoster: ok && hasRoster ? !!roster[v] : null, name: ok && hasRoster ? roster[v] : '' };
  }

  function updateReview() {
    const st = enrollmentStatus();
    $('rvName').textContent = !st.ok ? 'Enter all 9 digits' : st.onRoster === false ? 'Not on the roster' : st.name || '';
    $('rvName').className = !st.ok || st.onRoster === false ? 'err' : 'muted';
    $('rvEnr').classList.toggle('bad', !st.ok || st.onRoster === false);
    const unc = R.sel.filter((s) => s.state === 'uncertain' && !s.fixed).length;
    const parts = [];
    if (R.dup) parts.push('Already scanned on this phone');
    if (unc) parts.push(unc + ' to check');
    if (!st.ok) parts.push('enrollment incomplete');
    $('rvStatus').textContent = parts.length ? parts.join(' · ') : 'Ready';
    $('rvStatus').className = 'pill ' + (parts.length ? 'warn' : 'good');
    drawReview();
  }

  function drawReview() {
    const c = $('rvCanvas'), L = R.L;
    // show the enrollment block and the used part of the answer grid
    const top = L.enrollment.label.y - 6;
    const lastRow = Math.min(R.qr.nq, L.answers.rowsPerColumn) - 1;
    const bottom = L.answers.y0 + lastRow * L.answers.rowPitch + 6;
    R.view = { top, bottom };
    c.width = L.page.w * DISP; c.height = (bottom - top) * DISP;
    const ctx = c.getContext('2d');
    ctx.drawImage(R.disp, 0, top * DISP, c.width, c.height, 0, 0, c.width, c.height);
    const ring = (b, off, colour, w) => {
      ctx.strokeStyle = colour; ctx.lineWidth = w || 2.5;
      ctx.beginPath(); ctx.arc((b.x + off.dx) * DISP, (b.y + off.dy - top) * DISP, (b.r + 0.7) * DISP, 0, 2 * Math.PI); ctx.stroke();
    };
    // enrollment
    const eo = R.res.offsets.enrollment;
    const enr = $('rvEnr').value;
    for (let col = 0; col < L.enrollment.digits; col++) {
      const orig = R.enrOrig[col], now = enr[col];
      const it = R.res.enrItems[col];
      if (now && /\d/.test(now)) ring(OMRLayout.enrollmentBubble(L, col, +now), eo, now === orig ? '#2a9d8f' : '#457b9d');
      if (it.state !== 'marked') {
        for (let d = 0; d <= 9; d++) if (it.adj[d] >= OMRRecognize.DEFAULTS.emptyT) ring(OMRLayout.enrollmentBubble(L, col, d), eo, '#e9a23b');
        if (!now || !/\d/.test(now)) { const b0 = OMRLayout.enrollmentBubble(L, col, 0); ctx.fillStyle = 'rgba(233,162,59,.18)';
          ctx.fillRect((b0.x - 3 + eo.dx) * DISP, (b0.y - 3.5 + eo.dy - top) * DISP, 6 * DISP, 57 * DISP); }
      }
    }
    // answers
    R.sel.forEach((s, q) => {
      const off = R.res.offsets.columns[Math.floor(q / L.answers.rowsPerColumn)];
      const colour = s.fixed ? '#457b9d' : s.state === 'uncertain' ? '#e9a23b' : s.set.size > 1 ? '#e63946' : '#2a9d8f';
      if (s.state === 'uncertain' && !s.fixed) {
        const b0 = OMRLayout.answerBubble(L, q, 0);
        ctx.fillStyle = 'rgba(233,162,59,.22)';
        ctx.fillRect((b0.x - 3.2 + off.dx) * DISP, (b0.y - 2.85 + off.dy - top) * DISP, (3 * L.answers.optPitch + 6.4) * DISP, 5.7 * DISP);
      }
      s.set.forEach((k) => ring(OMRLayout.answerBubble(L, q, k), off, colour));
    });
  }

  $('rvCanvas').addEventListener('click', (ev) => {
    if (!R) return;
    const c = $('rvCanvas'), rect = c.getBoundingClientRect(), L = R.L;
    const mx = ((ev.clientX - rect.left) / rect.width) * L.page.w;
    const my = ((ev.clientY - rect.top) / rect.height) * (R.view.bottom - R.view.top) + R.view.top;
    let best = null;
    for (let q = 0; q < R.qr.nq; q++) {
      const off = R.res.offsets.columns[Math.floor(q / L.answers.rowsPerColumn)];
      for (let k = 0; k < 4; k++) {
        const b = OMRLayout.answerBubble(L, q, k);
        const d = Math.hypot(b.x + off.dx - mx, b.y + off.dy - my);
        if (d < 3.2 && (!best || d < best.d)) best = { d, type: 'a', q, k };
      }
    }
    const eo = R.res.offsets.enrollment;
    for (let col = 0; col < L.enrollment.digits; col++) for (let dgt = 0; dgt <= 9; dgt++) {
      const b = OMRLayout.enrollmentBubble(L, col, dgt);
      const d = Math.hypot(b.x + eo.dx - mx, b.y + eo.dy - my);
      if (d < 2.9 && (!best || d < best.d)) best = { d, type: 'e', col, dgt };
    }
    if (!best) return;
    if (best.type === 'a') {
      const s = R.sel[best.q];
      if (s.set.has(best.k)) s.set.delete(best.k); else { if (!s.multi) s.set.clear(); s.set.add(best.k); }
      s.fixed = true;
    } else {
      const v = $('rvEnr').value.padEnd(9, '?').split('');
      v[best.col] = String(best.dgt);
      $('rvEnr').value = v.join('').slice(0, 9);
    }
    vibrate(10);
    updateReview();
  });
  $('rvEnr').addEventListener('input', () => { $('rvEnr').value = $('rvEnr').value.replace(/[^0-9?]/g, '').slice(0, 9); updateReview(); });

  async function accept(auto) {
    const st = enrollmentStatus();
    if (!st.ok) { toast('Enter the full 9-digit enrollment number'); $('rvEnr').focus(); return; }
    const answers = answersString();
    const unc = (answers.match(/\?/g) || []).length;
    if (!auto && unc && !confirm(`${unc} question(s) are still unclear. They will be saved as "?" and the student's result stays pending until a coordinator resolves them. Save anyway?`)) return;
    if (!auto && R.dup && !confirm('This sheet was already scanned on this phone. Save a second copy? The backend will send it to Review.')) return;
    const corrections = [];
    if (st.v !== R.enrOrig) corrections.push({ field: 'enrollment', from: R.enrOrig, to: st.v });
    R.sel.forEach((s, i) => { const now = answers[i]; if (now !== s.orig) corrections.push({ field: 'Q' + (i + 1), from: s.orig, to: now }); });
    const rec = {
      scanId: uuid(), qr: R.qr.raw, paper: R.qr.paper, exam: R.qr.exam, set: R.qr.set, serial: R.qr.serial,
      serialKey: R.qr.paper + '|' + R.qr.serial, nq: R.qr.nq, enrollment: st.v, name: st.name || '',
      answers, uncertain: R.res.uncertain, corrections, scannedBy: Auth.email || 'demo',
      deviceTime: new Date().toISOString(), status: Settings.demo() ? 'local' : 'pending', thumb: R.thumb,
    };
    await Queue.put(rec);
    cam.count++;
    $('camCount').textContent = cam.count + ' scanned';
    refreshBadge();
    toast(`✓ ${st.v}${st.name ? ' · ' + st.name : ''}${corrections.length ? ' · ' + corrections.length + ' corrected' : ''}`);
    R = null;
    $('review').hidden = true;
    if (!Settings.demo()) Sync.schedule(1500);
    if (cam.stream) { cam.waitClear = true; resumeCamera(); } else $('scanStart').hidden = false;
  }

  $('btnAccept').onclick = () => accept(false);
  $('btnRetake').onclick = () => { R = null; $('review').hidden = true; if (cam.stream) resumeCamera(); else $('scanStart').hidden = false; };
  $('btnDiscard').onclick = () => { R = null; $('review').hidden = true; if (cam.stream) { cam.waitClear = true; resumeCamera(); } else $('scanStart').hidden = false; };

  // ---------------- history ----------------
  async function refreshBadge() {
    const p = await Queue.pending();
    $('pendingBadge').textContent = p.length; $('pendingBadge').hidden = !p.length;
  }
  async function renderHistory() {
    const all = await Queue.all();
    const pending = all.filter((r) => r.status === 'pending').length;
    $('syncLine').textContent = Settings.demo()
      ? `${all.length} scan(s) on this phone (demo mode — export as CSV)`
      : `${all.length} scan(s) on this phone · ${pending} waiting to sync${Sync.running ? ' · syncing…' : ''}`;
    $('syncErr').textContent = Sync.lastError || '';
    $('btnSync').hidden = Settings.demo();
    const list = $('histList');
    list.innerHTML = all.slice(0, 300).map((r) => {
      const st = r.status === 'local' ? ['On phone', ''] : r.status === 'pending' ? ['Waiting', 'warn']
        : r.serverStatus === 'OK' ? ['Saved', 'good'] : [(r.serverStatus || 'Saved').replace(/_/g, ' ').toLowerCase(), r.serverStatus ? 'bad' : 'good'];
      const unc = (r.answers.match(/\?/g) || []).length;
      return `<div class="item"><img src="${r.thumb}" alt="">
        <div class="grow"><div><b>${esc(r.enrollment)}</b> ${esc(r.name)}</div>
        <div class="muted small">${esc(r.paper)} · ${esc(r.exam)} · Set ${esc(r.set)} · sheet ${esc(r.serial)} · ${new Date(r.deviceTime).toLocaleString()}</div>
        ${unc ? `<div class="small err">${unc} unclear answer(s)</div>` : ''}${r.message ? `<div class="small muted">${esc(r.message)}</div>` : ''}</div>
        <span class="pill ${st[1]}">${esc(st[0])}</span></div>`;
    }).join('') || '<p class="muted center">No scans yet.</p>';
  }
  $('btnSync').onclick = async () => { await Sync.run(); renderHistory(); };
  $('btnClearSynced').onclick = async () => { await Queue.clearSynced(); renderHistory(); };
  $('btnCsv').onclick = async () => {
    const all = await Queue.all();
    const head = ['scanId', 'deviceTime', 'paper', 'exam', 'set', 'serial', 'enrollment', 'name', 'answers', 'corrections', 'status', 'serverStatus'];
    const rows = all.map((r) => head.map((h) => {
      let v = h === 'corrections' ? (r.corrections || []).map((c) => `${c.field}:${c.from}>${c.to}`).join(' ') : r[h];
      v = v == null ? '' : String(v);
      if (h === 'enrollment' || h === 'serial' || h === 'answers') v = "'" + v; // keep leading zeros / dashes in Excel
      return '"' + v.replace(/"/g, '""') + '"';
    }).join(','));
    const blob = new Blob([[head.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'omr-scans.csv'; a.click();
  };
  Sync.listeners.push(() => { refreshBadge(); if (!$('view-history').hidden) renderHistory(); });

  // ---------------- print ----------------
  function renderPrint() {
    const demo = Settings.demo();
    $('printDemo').hidden = !demo; $('printLive').hidden = demo;
    if (!demo) {
      const known = Courses.list();
      if (!$('prPaper').value && known.length) $('prPaper').value = known[0].paper;
      fillExams(Courses.get($('prPaper').value.trim().toUpperCase()));
    }
  }
  function fillExams(c) {
    const sel = $('prExam');
    sel.innerHTML = c && c.exams ? Object.values(c.exams).map((e) => `<option value="${esc(e.examId)}">${esc(e.examId)} — ${esc(e.title)} (${e.nq} Q, ${e.sets} set${e.sets > 1 ? 's' : ''})</option>`).join('') : '<option value="">Load a course first</option>';
  }
  $('btnPrLoad').onclick = async () => {
    const p = $('prPaper').value.trim().toUpperCase();
    try { fillExams(await Courses.load(p)); $('prMsg').textContent = ''; } catch (e) { $('prMsg').textContent = e.message; }
  };
  $('btnGenerate').onclick = async () => {
    const count = Math.max(1, Math.min(1000, parseInt($('prCount').value, 10) || 0));
    const date = $('prDate').value.trim();
    const msg = $('prMsg');
    $('btnGenerate').disabled = true; msg.textContent = 'Preparing sheets…';
    try {
      let sheets, file;
      if (Settings.demo()) {
        const nq = Math.max(1, Math.min(100, parseInt($('dmNq').value, 10) || 1));
        const sets = parseInt($('dmSets').value, 10);
        const paper = $('dmPaper').value.trim().toUpperCase().replace(/\|/g, ''), exam = $('dmExam').value.trim().replace(/\|/g, '');
        let serial = parseInt(localStorage.getItem('omr.demoSerial') || '1', 10);
        sheets = Array.from({ length: count }, (_, i) => {
          const f = { paper, exam, set: 'ABCD'[i % sets], nq, nopt: 4, layout: 'L100A', serial: String(serial + i).padStart(6, '0'), sig: '000000' };
          return { layoutId: 'L100A', course: $('dmCourse').value, paper, exam, examTitle: $('dmTitle').value, date, set: f.set, nq, serial: f.serial, qrText: OMRLayout.encodeQR(f) };
        });
        localStorage.setItem('omr.demoSerial', String(serial + count));
        file = `${paper}_${exam}_demo.pdf`;
      } else {
        const paper = $('prPaper').value.trim().toUpperCase(), exam = $('prExam').value;
        if (!exam) throw new Error('Choose an exam');
        const d = await call('reserveSerials', { paper, exam, count });
        sheets = d.sheets.map((s) => ({ layoutId: d.layout, course: d.course, paper, exam, examTitle: d.exam.title, date: date || d.exam.date || '',
          set: s.set, nq: d.exam.nq, serial: s.serial, qrText: s.qr }));
        file = `${paper}_${exam}_${d.sheets[0].serial}-${d.sheets[d.sheets.length - 1].serial}.pdf`;
      }
      msg.textContent = `Drawing ${sheets.length} sheets…`;
      await new Promise((r) => setTimeout(r, 30));
      const doc = OMRSheetPDF.buildPDF(window.jspdf.jsPDF, window.qrcode, sheets);
      doc.save(file);
      msg.textContent = `Done: ${sheets.length} sheets, serials ${sheets[0].serial}–${sheets[sheets.length - 1].serial}.`;
    } catch (e) { msg.textContent = e.message; } finally { $('btnGenerate').disabled = false; }
  };

  // ---------------- settings ----------------
  function renderSettings() {
    const s = Settings.get();
    $('stUrl').value = s.backendUrl; $('stClient').value = s.clientId; $('stAuto').checked = !!s.autoAccept;
    $('whoami').textContent = Settings.demo() ? 'Demo mode — no sign-in needed' : Auth.valid() ? 'Signed in as ' + Auth.email : 'Not signed in';
    $('btnSignOut').hidden = !Auth.valid();
    $('gsiButton').hidden = Settings.demo() || Auth.valid();
    $('courseList').innerHTML = Courses.list().map((c) => `<div class="item"><div class="grow"><b>${esc(c.paper)}</b> ${esc(c.course)}
      <div class="muted small">${esc(c.role)} · ${Object.keys(c.roster || {}).length} students · ${Object.keys(c.exams || {}).length} exams · updated ${new Date(c.fetchedAt).toLocaleString()}</div></div>
      <button class="ghost small" data-refresh="${esc(c.paper)}">Refresh</button><button class="ghost small" data-remove="${esc(c.paper)}">Remove</button></div>`).join('')
      || '<p class="muted small">Courses are added automatically when you scan their sheets, or add one here.</p>';
  }
  $('courseList').addEventListener('click', async (e) => {
    const r = e.target.dataset.refresh, d = e.target.dataset.remove;
    if (d) { Courses.remove(d); renderSettings(); }
    if (r) { try { await Courses.load(r); toast('Updated ' + r); } catch (er) { toast(er.message, 3500); } renderSettings(); }
  });
  $('btnAddCourse').onclick = async () => {
    const p = $('stPaper').value.trim().toUpperCase(); if (!p) return;
    try { await Courses.load(p); $('stPaper').value = ''; toast('Added ' + p); } catch (e) { toast(e.message, 3500); }
    renderSettings();
  };
  $('stAuto').onchange = () => Settings.set({ autoAccept: $('stAuto').checked });
  $('btnSaveConn').onclick = () => {
    Settings.set({ backendUrl: $('stUrl').value.trim(), clientId: $('stClient').value.trim() });
    initAuth(); renderSettings(); updateMode(); toast('Saved');
  };
  $('btnSignOut').onclick = () => { Auth.signOut(); renderSettings(); };

  function updateMode() {
    $('scanMode').textContent = Settings.demo() ? 'Demo mode: scans stay on this phone. Set up a backend in Settings to share results.'
      : Auth.valid() ? 'Signed in as ' + Auth.email : 'Sign in under Settings so scans can sync.';
  }
  function initAuth() {
    if (Settings.demo()) return;
    let tries = 0;
    const t = setInterval(() => {
      if (window.google && google.accounts) { clearInterval(t); Auth.init($('gsiButton')); }
      else if (++tries > 50) clearInterval(t);
    }, 200);
  }
  Auth.listeners.push(() => { updateMode(); if (!$('view-settings').hidden) renderSettings(); if (Auth.valid()) { banner(''); Sync.run(); } });

  // ---------------- boot ----------------
  Auth.restore();
  initAuth();
  updateMode();
  refreshBadge();
  if (!Settings.demo()) setInterval(() => { if (!Auth.valid() && Auth.token) banner('Sign-in expired — open Settings to sign in again. Scans are kept on this phone.', 'warn'); Sync.run(); }, 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (window.cv && window.cv.Mat) cvScriptLoaded();

  window.OMRApp = { cvScriptLoaded, show };
})();
