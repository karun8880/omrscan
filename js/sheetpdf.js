/*
 * Draws OMR sheets into a jsPDF document using the shared layout template.
 * Works in the browser (window.jspdf, window.qrcode) and in Node (for tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./layout.js'));
  else root.OMRSheetPDF = factory(root.OMRLayout);
})(typeof self !== 'undefined' ? self : this, function (OMRLayout) {
  'use strict';

  const GREY = 150, LIGHT = 190, INK = 0;

  function drawQR(doc, qrcodeLib, text, x, y, size) {
    const qr = qrcodeLib(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 3;
    const m = size / (n + 2 * quiet);
    doc.setFillColor(255, 255, 255);
    doc.rect(x, y, size, size, 'F');
    doc.setFillColor(0, 0, 0);
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (qr.isDark(r, c)) {
          let run = 1;
          while (c + run < n && qr.isDark(r, c + run)) run++;
          // tiny overlap avoids hairline gaps in some PDF viewers
          doc.rect(x + (quiet + c) * m, y + (quiet + r) * m, run * m + 0.02, m + 0.02, 'F');
          c += run;
        } else c++;
      }
    }
  }

  function bubble(doc, b, label) {
    doc.setDrawColor(GREY);
    doc.setLineWidth(0.22);
    doc.circle(b.x, b.y, b.r, 'S');
    if (label) {
      doc.setTextColor(LIGHT);
      doc.setFontSize(6.2);
      doc.text(label, b.x, b.y + 0.75, { align: 'center' });
    }
  }

  /**
   * opts: { layoutId, course, paper, exam, examTitle, date, set, nq, serial, qrText, setsCount }
   */
  function drawSheet(doc, qrcodeLib, opts) {
    const L = OMRLayout.get(opts.layoutId || 'L100A');
    if (!L) throw new Error('Unknown layout ' + opts.layoutId);

    // Corner markers
    doc.setFillColor(0, 0, 0);
    const half = L.marker.size / 2;
    OMRLayout.markerCenters(L).forEach(([cx, cy], i) => {
      doc.rect(cx - half, cy - half, L.marker.size, L.marker.size, 'F');
      if (i === 0) {
        doc.setFillColor(255, 255, 255);
        const h = L.marker.hole / 2;
        doc.rect(cx - h, cy - h, L.marker.hole, L.marker.hole, 'F');
        doc.setFillColor(0, 0, 0);
      }
    });

    // QR code
    drawQR(doc, qrcodeLib, opts.qrText, L.qr.x, L.qr.y, L.qr.size);
    doc.setTextColor(INK);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.text('Sheet ' + opts.serial, L.qr.x + L.qr.size / 2, L.qr.y + L.qr.size + 2.6, { align: 'center' });

    // Header
    const h = L.header;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(String(opts.course || '').slice(0, 48), h.x, h.y + 4.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('Paper code: ' + opts.paper + '     Exam: ' + (opts.examTitle || opts.exam), h.x, h.y + 10);
    doc.text('Date: ' + (opts.date || '________________') + '     Questions: ' + opts.nq, h.x, h.y + 15);
    doc.text('Name: ______________________________   Signature: ________________', h.x, h.y + 24);
    // Set letter, large and boxed
    doc.setDrawColor(INK);
    doc.setLineWidth(0.5);
    doc.rect(138, h.y, 20, 18, 'S');
    doc.setFontSize(7);
    doc.text('SET', 148, h.y + 3.8, { align: 'center' });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.text(opts.set, 148, h.y + 14.5, { align: 'center' });
    doc.setFont('helvetica', 'normal');

    // Enrollment grid
    const e = L.enrollment;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('ENROLLMENT NUMBER', e.label.x, e.label.y);
    doc.setFont('helvetica', 'normal');
    doc.setDrawColor(GREY);
    doc.setLineWidth(0.25);
    for (let c = 0; c < e.digits; c++) {
      const top = OMRLayout.enrollmentBubble(L, c, 0);
      doc.rect(top.x - e.colPitch / 2 + 0.3, e.writeIn.y, e.colPitch - 0.6, e.writeIn.h, 'S');
      for (let d = 0; d <= 9; d++) bubble(doc, OMRLayout.enrollmentBubble(L, c, d), String(d));
    }

    // Instructions
    const ins = L.instructions;
    doc.setDrawColor(LIGHT);
    doc.setLineWidth(0.3);
    doc.rect(ins.x, ins.y, ins.w, ins.h, 'S');
    doc.setTextColor(INK);
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'bold');
    doc.text('INSTRUCTIONS', ins.x + 4, ins.y + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.8);
    const lines = [
      '1. Use a dark blue or black ballpoint pen only.',
      '2. Write your enrollment number in the boxes, then fill',
      '   the matching circle in each column.',
      '3. Fill each circle completely. Do not tick or cross.',
      '4. Fill only ONE circle per question.',
      '5. Do not erase. To change an answer, ask the',
      '   invigilator for a fresh sheet.',
      '6. Do not fold, staple or write near the black squares',
      '   or the QR code.',
    ];
    lines.forEach((t, i) => doc.text(t, ins.x + 4, ins.y + 13 + i * 4.6));
    // Example of a correct mark
    doc.text('Correct:', ins.x + 4, ins.y + 62);
    doc.setFillColor(0, 0, 0);
    doc.circle(ins.x + 21, ins.y + 61.3, 2.1, 'F');
    doc.text('Wrong:', ins.x + 34, ins.y + 62);
    doc.setDrawColor(GREY);
    doc.circle(ins.x + 49, ins.y + 61.3, 2.1, 'S');
    doc.setDrawColor(0);
    doc.setLineWidth(0.4);
    doc.line(ins.x + 47.6, ins.y + 61.3, ins.x + 48.8, ins.y + 62.7);
    doc.line(ins.x + 48.8, ins.y + 62.7, ins.x + 51, ins.y + 59.6);
    doc.setDrawColor(GREY);
    doc.setLineWidth(0.22);
    doc.circle(ins.x + 57, ins.y + 61.3, 2.1, 'S');
    doc.setLineWidth(0.4);
    doc.setDrawColor(0);
    doc.line(ins.x + 55.5, ins.y + 59.8, ins.x + 58.5, ins.y + 62.8);
    doc.line(ins.x + 58.5, ins.y + 59.8, ins.x + 55.5, ins.y + 62.8);

    // Answer grid
    const a = L.answers;
    doc.setFontSize(7);
    doc.setTextColor(GREY);
    for (let c = 0; c < a.columns; c++) {
      if (c * a.rowsPerColumn >= opts.nq) break;
      a.options.forEach((o, k) => doc.text(o, a.colX[c] + a.bubbleDx + k * a.optPitch, a.headerY, { align: 'center' }));
    }
    for (let q = 0; q < a.maxQuestions; q++) {
      const lp = OMRLayout.questionLabelPos(L, q);
      const used = q < opts.nq;
      if (!used && Math.floor(q / a.rowsPerColumn) * a.rowsPerColumn >= opts.nq) continue; // whole column unused
      doc.setFontSize(7.5);
      doc.setFont('helvetica', used ? 'bold' : 'normal');
      doc.setTextColor(used ? INK : 215);
      doc.text(String(q + 1), lp.x, lp.y + 0.9, { align: 'right' });
      if (used) a.options.forEach((o, k) => bubble(doc, OMRLayout.answerBubble(L, q, k), o));
    }
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(INK);
    doc.setFontSize(6);
    // Footer: >= 4.6 mm from the paper edge (printer margin) and > 13 mm clear of both bottom
    // markers, so blur can never merge it with a marker. Centred: 44 mm text + 2 mm + 100 mm line.
    doc.text('Print at 100%. This line must measure 100 mm:', 31.8, 292.4);
    doc.setDrawColor(0);
    doc.setLineWidth(0.3);
    doc.line(78.2, 291.8, 178.2, 291.8);
  }

  /** sheets: array of opts; returns the jsPDF document */
  function buildPDF(jsPDF, qrcodeLib, sheets) {
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    sheets.forEach((s, i) => { if (i) doc.addPage(); drawSheet(doc, qrcodeLib, s); });
    return doc;
  }

  return { drawSheet, buildPDF };
});
