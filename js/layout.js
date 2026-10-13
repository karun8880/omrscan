/*
 * OMR layout template L100A — the single source of truth for sheet geometry.
 * All units are millimetres on an A4 portrait page (210 x 297).
 * The PDF generator draws from this file and the scanner reads from it,
 * so they can never drift apart. Change geometry ONLY by adding a new layout ID.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OMRLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const L100A = {
    id: 'L100A',
    page: { w: 210, h: 297 },
    // Solid 10 mm squares, 8 mm in from each edge. TL has a white 4 mm centre (orientation cue).
    marker: { size: 10, inset: 8, hole: 4 },
    // Canonical warped image resolution (pixels per mm).
    pxPerMm: 8,
    qr: { x: 163, y: 22, size: 28 },          // top-right, includes quiet zone
    header: { x: 22, y: 22, w: 136, h: 30 },
    enrollment: {
      digits: 9,
      label: { x: 22, y: 58 },
      writeIn: { y: 60.5, h: 6 },             // boxes above each column
      x0: 25, colPitch: 6.4,                  // centre of first column, spacing
      y0: 71, rowPitch: 5.5,                  // centre of digit 0 row, spacing (digits 0..9)
      r: 2.1,                                 // bubble radius
    },
    instructions: { x: 92, y: 56, w: 98, h: 69 },
    answers: {
      maxQuestions: 100, options: ['A', 'B', 'C', 'D'],
      columns: 4, rowsPerColumn: 25,
      colX: [22, 66, 110, 154],               // left edge of each answer column
      numberDx: 8,                            // question number right-aligned at colX + numberDx
      bubbleDx: 12, optPitch: 6.4,            // first bubble centre at colX + bubbleDx
      y0: 136, rowPitch: 5.7,                 // centre of first row, row spacing
      headerY: 130.5,
      r: 2.2,
    },
  };

  function markerCenters(L) {
    const m = L.marker, c = m.inset + m.size / 2, W = L.page.w, H = L.page.h;
    // order: TL, TR, BR, BL
    return [[c, c], [W - c, c], [W - c, H - c], [c, H - c]];
  }

  function enrollmentBubble(L, digitCol, digit) {
    const e = L.enrollment;
    return { x: e.x0 + digitCol * e.colPitch, y: e.y0 + digit * e.rowPitch, r: e.r };
  }

  function answerBubble(L, q /* 0-based */, opt /* 0-based */) {
    const a = L.answers;
    const col = Math.floor(q / a.rowsPerColumn), row = q % a.rowsPerColumn;
    return { x: a.colX[col] + a.bubbleDx + opt * a.optPitch, y: a.y0 + row * a.rowPitch, r: a.r };
  }

  function questionLabelPos(L, q) {
    const a = L.answers;
    const col = Math.floor(q / a.rowsPerColumn), row = q % a.rowsPerColumn;
    return { x: a.colX[col] + a.numberDx, y: a.y0 + row * a.rowPitch };
  }

  // QR payload:  OMR1|<paper>|<exam>|<set>|<nq>|<nopt>|<layout>|<serial>|<sig>
  function encodeQR(f) {
    return ['OMR1', f.paper, f.exam, f.set, f.nq, f.nopt, f.layout, f.serial, f.sig].join('|');
  }
  function decodeQR(s) {
    const p = String(s || '').trim().split('|');
    if (p.length !== 9 || p[0] !== 'OMR1') return null;
    const f = { version: p[0], paper: p[1], exam: p[2], set: p[3], nq: parseInt(p[4], 10),
      nopt: parseInt(p[5], 10), layout: p[6], serial: p[7], sig: p[8], raw: String(s).trim() };
    if (!f.paper || !f.exam || !/^[A-D]$/.test(f.set) || !(f.nq >= 1 && f.nq <= 100) || f.nopt !== 4) return null;
    return f;
  }

  const layouts = { L100A };
  return { layouts, get: (id) => layouts[id] || null, markerCenters, enrollmentBubble,
    answerBubble, questionLabelPos, encodeQR, decodeQR };
});
