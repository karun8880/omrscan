/*
 * Offline scoring — the same rules as the backend (backend/Code.gs: parseKey_, scoreAnswers_),
 * used for the scores in the CSV export when there is no Google Sheet.
 *
 * Key: one character per question. A–D correct option, [AC] either option, X cancelled (everyone
 * gets the marks). Answers: A–D read, '-' blank, '*' more than one mark, '?' unclear.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OMRScore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** "AC[BD]XD" -> [['A'],['C'],['B','D'],'X',['D']]; null if the key has an invalid character */
  function parseKey(key) {
    const out = [], s = String(key || '').toUpperCase().replace(/\s+/g, '');
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      if (ch === '[') {
        const j = s.indexOf(']', i);
        if (j < 0) return null;
        const opts = s.slice(i + 1, j).split('');
        if (!opts.length || opts.some((o) => 'ABCD'.indexOf(o) < 0)) return null;
        out.push(opts); i = j;
      } else if (ch === 'X') out.push('X');
      else if ('ABCD'.indexOf(ch) >= 0) out.push([ch]);
      else if (ch === ',') continue;
      else return null;
    }
    return out;
  }

  /** rules: { plus, minus, multiple: 'wrong'|'blank' } */
  function scoreAnswers(answers, key, rules) {
    const nq = key.length;
    const c = { correct: 0, wrong: 0, blank: 0, multiple: 0, unresolved: 0, score: 0, max: 0 };
    for (let i = 0; i < nq; i++) {
      const plus = rules.plus;
      c.max += plus;
      const a = answers.charAt(i), k = key[i];
      if (k === 'X') { c.correct++; c.score += plus; continue; }
      if (a === '?') { c.unresolved++; continue; }
      if (a === '-' || a === '') { c.blank++; continue; }
      if (a === '*') { c.multiple++; if (rules.multiple === 'wrong') { c.wrong++; c.score -= rules.minus; } continue; }
      if (k.indexOf(a) >= 0) { c.correct++; c.score += plus; } else { c.wrong++; c.score -= rules.minus; }
    }
    c.score = Math.round(c.score * 100) / 100;
    return c;
  }

  /**
   * Parses the Settings text: one line per exam and set, "ExamId,Set,Key".
   * Returns { keys: {'EXAM|A': parsedKey}, errors: ['line 2: ...'] }.
   */
  function parseKeyTable(text) {
    const keys = {}, errors = [];
    String(text || '').split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const m = /^([^,\t]+)[,\t]\s*([A-Da-d])\s*[,\t]\s*(.+)$/.exec(t);
      if (!m) { errors.push(`line ${i + 1}: expected ExamId,Set,Key`); return; }
      const k = parseKey(m[3]);
      if (!k || !k.length) { errors.push(`line ${i + 1}: key has a character other than A–D, [..] or X`); return; }
      keys[m[1].trim() + '|' + m[2].toUpperCase()] = k;
    });
    return { keys, errors };
  }

  /** Scores one scan record {exam,set,answers,nq} against a key table; returns columns for the CSV. */
  function scoreRecord(rec, table, rules) {
    const key = table.keys[rec.exam + '|' + rec.set];
    const blank = { correct: '', wrong: '', blank: '', multiple: '', unresolved: '', score: '', maxScore: '' };
    if (!key) return Object.assign(blank, { scoreStatus: 'Awaiting key' });
    if (key.length !== rec.answers.length) return Object.assign(blank, { scoreStatus: `Key has ${key.length} answers, sheet has ${rec.answers.length}` });
    const c = scoreAnswers(rec.answers, key, rules);
    return { correct: c.correct, wrong: c.wrong, blank: c.blank, multiple: c.multiple, unresolved: c.unresolved,
      score: c.unresolved ? '' : c.score, maxScore: c.max, scoreStatus: c.unresolved ? 'Pending review' : 'Final' };
  }

  return { parseKey, scoreAnswers, parseKeyTable, scoreRecord };
});
