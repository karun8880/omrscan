/*
 * OMR recognition pipeline. Pure functions over OpenCV.js + jsQR.
 * Runs in the browser (cv, jsQR globals) and in Node (for tests).
 *
 *   detectMarkers(cv, gray)       -> page corners TL,TR,BR,BL (page order) or null
 *   recognize(cv, jsQR, rgba)     -> full reading of one sheet
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./layout.js'));
  else root.OMRRecognize = factory(root.OMRLayout);
})(typeof self !== 'undefined' ? self : this, function (OMRLayout) {
  'use strict';

  const DEFAULTS = {
    detectMaxDim: 1000,     // marker search runs on a downscaled copy
    fillT: 0.33,            // darkness above sheet baseline that counts as "filled"
    emptyT: 0.16,           // below this a bubble is clearly empty
    gapT: 0.15,             // a lone mark must beat the runner-up by this much
    sampleR: 0.62,          // sample inside this fraction of the bubble radius
    minRing: 14,            // minimum outline darkness (0-255) proving a block is aligned
    bwMaxMid: 0.018,        // below this share of mid-grey pixels the page is a black-and-white scan
    allowBW: false,         // read black-and-white scans anyway (faint marks can be lost)
  };

  function oddInt(v) { v = Math.max(3, Math.round(v)); return v % 2 ? v : v + 1; }

  function rgbaToGray(cv, img) {
    const src = cv.matFromImageData(img);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    src.delete();
    return gray;
  }

  /** Sharpness score (variance of Laplacian) on a gray Mat. */
  function sharpness(cv, gray) {
    const lap = new cv.Mat(), mean = new cv.Mat(), sd = new cv.Mat();
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, sd);
    const v = sd.data64F[0] * sd.data64F[0];
    lap.delete(); mean.delete(); sd.delete();
    return v;
  }

  /** Solid, square, dark blobs in a binary image: marker candidates. */
  function squareBlobs(cv, bin, maxDim) {
    const contours = new cv.MatVector(), hier = new cv.Mat();
    // RETR_LIST, not EXTERNAL: a dark table around the page forms one big contour that
    // would otherwise hide the markers inside it.
    cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const minArea = maxDim * maxDim * 0.00012, maxArea = maxDim * maxDim * 0.02;
    const cands = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area < minArea || area > maxArea) { c.delete(); continue; }
      const peri = cv.arcLength(c, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.06 * peri, true);
      const rr = cv.minAreaRect(c);
      const rw = rr.size.width, rh = rr.size.height;
      const extent = area / Math.max(1, rw * rh);
      const aspect = Math.max(rw, rh) / Math.max(1, Math.min(rw, rh));
      const hull = new cv.Mat();
      cv.convexHull(c, hull);
      const solidity = area / Math.max(1, cv.contourArea(hull));
      let ok = approx.rows === 4 && extent > 0.84 && aspect < 1.6 && solidity > 0.9;
      let fill = 0;
      if (ok) {
        const br = cv.boundingRect(c);
        const mask = cv.Mat.zeros(br.height, br.width, cv.CV_8UC1);
        const shifted = new cv.MatVector();
        const cc = c.clone();
        for (let k = 0; k < cc.data32S.length; k += 2) { cc.data32S[k] -= br.x; cc.data32S[k + 1] -= br.y; }
        shifted.push_back(cc);
        cv.drawContours(mask, shifted, 0, new cv.Scalar(255), -1);
        const roi = bin.roi(br);
        fill = cv.mean(roi, mask)[0] / 255;
        roi.delete(); mask.delete(); shifted.delete(); cc.delete();
        ok = fill > 0.72;
      }
      if (ok) {
        const m = cv.moments(c);
        cands.push({ x: m.m10 / m.m00, y: m.m01 / m.m00, area, fill });
      }
      approx.delete(); hull.delete(); c.delete();
    }
    contours.delete(); hier.delete();
    return cands;
  }

  /** Picks the four markers from candidates and puts them in page order. Returns {quad, ref} or {error}. */
  function pickMarkers(cv, small, cands) {
    const NOT_FOUND = 'Corner markers not found — fit all four black squares in the frame';
    if (cands.length < 4) return { error: NOT_FOUND };
    // Markers are the largest group of >= 4 solid squares of similar size. The 2.9x window
    // matches the tilt check below (sides may differ 0.6x, so areas up to 1/0.6^2 = 2.8x).
    // Filled bubbles are ~0.2x a marker's area and the QR outline is far bigger, so neither
    // joins the group; a cut-off marker leaves only three and fails cleanly.
    cands = cands.slice().sort((a, b) => b.area - a.area);
    let pool = null;
    for (const c of cands) {
      const g = cands.filter((d) => d.area <= c.area && d.area >= c.area / 2.9);
      if (g.length >= 4) { pool = g; break; }
    }
    if (!pool) return { error: NOT_FOUND };
    const ref = pool[Math.min(3, pool.length - 1)].area;
    // Image-space corners by extremes of x+y and x-y.
    const pick = (f) => pool.reduce((best, c) => (f(c) > f(best) ? c : best));
    const tl = pick((c) => -(c.x + c.y)), br = pick((c) => c.x + c.y);
    const tr = pick((c) => c.x - c.y), bl = pick((c) => c.y - c.x);
    const quad = [tl, tr, br, bl];
    if (new Set(quad).size !== 4) return { error: NOT_FOUND };

    // Orientation: the top-left marker has a white centre.
    const centreVal = quad.map((c) => {
      const r = Math.max(1, Math.round(Math.sqrt(c.area) * 0.12));
      const x0 = Math.max(0, Math.round(c.x) - r), y0 = Math.max(0, Math.round(c.y) - r);
      const roi = small.roi(new cv.Rect(x0, y0, Math.min(2 * r + 1, small.cols - x0), Math.min(2 * r + 1, small.rows - y0)));
      const v = cv.mean(roi)[0];
      roi.delete();
      return v;
    });
    const order = centreVal.map((v, i) => i).sort((a, b) => centreVal[b] - centreVal[a]);
    const rotate = (k) => [0, 1, 2, 3].map((i) => quad[(k + i) % 4]);

    // Sanity: the quad should be roughly the page's proportions (allowing for perspective).
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const shape = (q) => {
      const wTop = d(q[0], q[1]), wBot = d(q[3], q[2]), hL = d(q[0], q[3]), hR = d(q[1], q[2]);
      const ratio = ((hL + hR) / 2) / ((wTop + wBot) / 2);
      const bad = ratio < 1.0 || ratio > 2.1 || Math.min(wTop, wBot) / Math.max(wTop, wBot) < 0.6 || Math.min(hL, hR) / Math.max(hL, hR) < 0.6;
      return { ratio, bad };
    };
    const TILT = 'Sheet looks too tilted — hold the phone flat above the sheet';

    if (centreVal[order[0]] - centreVal[order[1]] >= 35) {
      const pageOrder = rotate(order[0]);
      if (shape(pageOrder).bad) return { error: TILT };
      return { quad: pageOrder, ref };
    }
    // The white centre is hidden (a pen stroke through it, glare). The page is portrait, so its
    // long side fixes the orientation up to 180 degrees; recognize() tries both and keeps the one
    // whose QR code (always top-right) decodes.
    const k0 = shape(rotate(0)).ratio >= 1 ? 0 : 1;
    const a = rotate(k0), b = rotate(k0 + 2);
    if (shape(a).bad) return { error: TILT };
    return { quad: a, alt: b, ref, ambiguous: true };
  }

  /**
   * Find the four corner markers. Returns { corners:[[x,y]...] in page order TL,TR,BR,BL
   * (full-resolution coordinates), sizePx } or { error }.
   *
   * Pass 1 uses the plain threshold image. If that fails, passes 2-3 first remove thin dark
   * strokes (morphological opening), which separates a marker from pen marks, handwriting or a
   * line touching it under blur; solid 10 mm markers survive the opening.
   */
  function detectMarkers(cv, gray, opts) {
    opts = Object.assign({}, DEFAULTS, opts);
    const scale = Math.min(1, opts.detectMaxDim / Math.max(gray.cols, gray.rows));
    const small = new cv.Mat();
    if (scale < 1) cv.resize(gray, small, new cv.Size(Math.round(gray.cols * scale), Math.round(gray.rows * scale)), 0, 0, cv.INTER_AREA);
    else gray.copyTo(small);
    const blur = new cv.Mat(), bin = new cv.Mat();
    cv.GaussianBlur(small, blur, new cv.Size(5, 5), 0);
    const maxDim = Math.max(small.cols, small.rows);
    cv.adaptiveThreshold(blur, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, oddInt(maxDim / 9), 18);

    let first = null, found = 0, best = null, fallback = null;
    for (const k of [0, 3, 5]) {
      const src = bin;
      let b = src;
      if (k) {
        b = new cv.Mat();
        const se = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k));
        cv.morphologyEx(src, b, cv.MORPH_OPEN, se);
        se.delete();
      }
      const cands = squareBlobs(cv, b, maxDim);
      if (b !== src) b.delete();
      const r = pickMarkers(cv, small, cands);
      found = Math.max(found, cands.length);
      // An orientation-unknown quad is kept only as a last resort: when a stroke hides the
      // top-left cue, a later pass usually removes the stroke and finds the cue, and a quad of
      // look-alike blobs (filled bubbles) is never accepted while a real answer is still possible.
      if (!r.error && !r.ambiguous) { best = { r, k }; break; }
      if (!r.error && !fallback) fallback = { r, k };
      if (!first) first = r.error;
    }
    bin.delete(); small.delete(); blur.delete();
    const pickd = best || fallback;
    if (!pickd) return { error: first, found };
    const inv = 1 / scale;
    const full = (q) => q.map((c) => [c.x * inv, c.y * inv]);
    return { corners: full(pickd.r.quad), alt: pickd.r.alt ? full(pickd.r.alt) : null, sizePx: Math.sqrt(pickd.r.ref) * inv, pass: pickd.k };
  }

  function warpToCanonical(cv, gray, corners, L) {
    const ppm = L.pxPerMm;
    const dst = OMRLayout.markerCenters(L).map(([x, y]) => [x * ppm, y * ppm]);
    const srcM = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat(...corners));
    const dstM = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat(...dst));
    const M = cv.getPerspectiveTransform(srcM, dstM);
    const out = new cv.Mat();
    cv.warpPerspective(gray, out, M, new cv.Size(Math.round(L.page.w * ppm), Math.round(L.page.h * ppm)),
      cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255));
    srcM.delete(); dstM.delete(); M.delete();
    return out;
  }

  /** Divide by a local background estimate so shadows and uneven light do not shift darkness. */
  function normalise(cv, warped) {
    const small = new cv.Mat(), bg = new cv.Mat(), out = new cv.Mat();
    cv.resize(warped, small, new cv.Size(Math.round(warped.cols / 4), Math.round(warped.rows / 4)), 0, 0, cv.INTER_AREA);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(21, 21));
    cv.dilate(small, small, k);                 // max filter removes ink, keeps paper brightness
    cv.GaussianBlur(small, small, new cv.Size(31, 31), 0);
    cv.resize(small, bg, new cv.Size(warped.cols, warped.rows), 0, 0, cv.INTER_LINEAR);
    // darkness = 255 - 255 * gray / bg
    const g = warped.data, b = bg.data;
    out.create(warped.rows, warped.cols, cv.CV_8UC1);
    const o = out.data;
    for (let i = 0; i < g.length; i++) {
      const bb = Math.max(b[i], 40);
      const v = 255 - Math.round(255 * Math.min(1, g[i] / bb));
      o[i] = v;
    }
    small.delete(); bg.delete(); k.delete();
    return out;
  }

  function bubbleDarkness(dark, L, b, sampleR) {
    const ppm = L.pxPerMm, W = dark.cols, data = dark.data;
    const cx = b.x * ppm, cy = b.y * ppm, r = b.r * ppm * sampleR, r2 = r * r;
    let sum = 0, n = 0;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) { sum += data[y * W + x]; n++; }
      }
    }
    return n ? sum / n / 255 : 0;
  }

  /**
   * Local re-centring: a printed sheet is never perfectly flat, so nudge each block
   * (enrollment, each answer column) by up to ±1 mm to where the printed circles sit.
   * Score = mean darkness on the circle outline ring.
   */
  function blockOffset(dark, L, bubbles) {
    const ppm = L.pxPerMm, W = dark.cols, H = dark.rows, data = dark.data;
    let best = { dx: 0, dy: 0, s: -1 };
    const steps = [-8, -6, -4, -2, 0, 2, 4, 6, 8]; // pixels at 8 px/mm => ±1 mm
    const sample = bubbles.filter((_, i) => i % 3 === 0).slice(0, 60);
    for (const ox of steps) for (const oy of steps) {
      let s = 0, n = 0;
      for (const b of sample) {
        const cx = b.x * ppm + ox, cy = b.y * ppm + oy, R = b.r * ppm;
        for (let a = 0; a < 24; a++) {
          const t = (a / 24) * 2 * Math.PI;
          const x = Math.round(cx + R * Math.cos(t)), y = Math.round(cy + R * Math.sin(t));
          if (x >= 0 && y >= 0 && x < W && y < H) { s += data[y * W + x]; n++; }
        }
      }
      s /= Math.max(1, n);
      if (s > best.s) best = { dx: ox / ppm, dy: oy / ppm, s };
    }
    return best;
  }

  function classify(scores, base, o) {
    const adj = scores.map((s) => s - base);
    const idx = adj.map((v, i) => i).sort((a, b) => adj[b] - adj[a]);
    const d1 = adj[idx[0]], d2 = adj[idx[1]];
    const filled = adj.filter((v) => v >= o.fillT).length;
    let state, choice = null;
    if (filled === 0 && d1 < o.emptyT) state = 'blank';
    else if (filled === 1 && d2 < o.emptyT && d1 - d2 >= o.gapT) { state = 'marked'; choice = idx[0]; }
    else if (filled >= 2 && d2 >= o.fillT && adj[idx[1]] > 0.6 * d1) state = 'multiple';
    else state = 'uncertain';
    // confidence: distance of the decision from the nearest threshold, 0..1
    let conf;
    if (state === 'blank') conf = Math.min(1, (o.emptyT - d1) / o.emptyT);
    else if (state === 'marked') conf = Math.min(1, Math.min(d1 - o.fillT, o.emptyT - d2, d1 - d2 - o.gapT) / 0.1 + 0.5);
    else if (state === 'multiple') conf = Math.min(1, (d2 - o.fillT) / 0.1 + 0.5);
    else conf = 0;
    return { state, choice, conf: Math.max(0, Math.round(conf * 100) / 100), adj: adj.map((v) => Math.round(v * 100) / 100) };
  }

  function median(a) { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

  function decodeQRRegion(cv, jsQR, warped, L) {
    const ppm = L.pxPerMm, m = 3;
    const x = Math.max(0, Math.round((L.qr.x - m) * ppm)), y = Math.max(0, Math.round((L.qr.y - m) * ppm));
    const w = Math.min(warped.cols - x, Math.round((L.qr.size + 2 * m) * ppm));
    const h = Math.min(warped.rows - y, Math.round((L.qr.size + 2 * m) * ppm));
    const roiView = warped.roi(new cv.Rect(x, y, w, h));
    const roi = roiView.clone();
    roiView.delete();
    const read = (g) => {
      const rgba = new cv.Mat();
      cv.cvtColor(g, rgba, cv.COLOR_GRAY2RGBA);
      const r = jsQR(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows, { inversionAttempts: 'dontInvert' });
      rgba.delete();
      return r && r.data && OMRLayout.decodeQR(r.data) ? r.data : (r && r.data ? '\u0000' + r.data : null);
    };
    // Plain read first; the fallbacks recover blurred or unevenly lit codes.
    const passes = [
      () => roi.clone(),
      () => { const b = new cv.Mat(), o = new cv.Mat(); cv.GaussianBlur(roi, b, new cv.Size(0, 0), 3); cv.addWeighted(roi, 2.0, b, -1.0, 0, o); b.delete(); return o; },
      () => { const o = new cv.Mat(); cv.adaptiveThreshold(roi, o, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 51, 4); return o; },
      () => { const o = new cv.Mat(); cv.resize(roi, o, new cv.Size(Math.round(w * 0.66), Math.round(h * 0.66)), 0, 0, cv.INTER_AREA); return o; },
      () => { const o = new cv.Mat(); cv.threshold(roi, o, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU); return o; },
    ];
    let text = null, foreign = null;
    for (const make of passes) {
      const g = make();
      const t = read(g);
      g.delete();
      if (t && t.charCodeAt(0) !== 0) { text = t; break; }
      if (t) foreign = t.slice(1);
    }
    roi.delete();
    return text || foreign;
  }

  /**
   * Full reading of a sheet image.
   * img: ImageData-like {data: RGBA Uint8ClampedArray, width, height}
   * returns { ok, error?, qr, enrollment, enrollmentStates, answers, items, uncertain, warped (Mat, caller deletes) }
   */
  function recognize(cv, jsQR, img, opts) {
    opts = Object.assign({}, DEFAULTS, opts);
    const gray = rgbaToGray(cv, img);
    const det = detectMarkers(cv, gray, opts);
    if (det.error) { gray.delete(); return { ok: false, error: det.error }; }
    const L0 = OMRLayout.get('L100A');
    // Normally one orientation; when the top-left cue was hidden, also the 180-degree turn.
    let warped = null, qrText = null, qr = null;
    for (const corners of [det.corners, det.alt].filter(Boolean)) {
      if (warped) warped.delete();
      warped = warpToCanonical(cv, gray, corners, L0);
      qrText = decodeQRRegion(cv, jsQR, warped, L0);
      qr = OMRLayout.decodeQR(qrText);
      if (qr) { det.corners = corners; break; }
    }
    gray.delete();
    if (!qr) { warped.delete(); return { ok: false, error: qrText ? 'QR code is not from this system' : 'QR code could not be read — avoid glare on the top-right corner' }; }
    const L = OMRLayout.get(qr.layout);
    if (!L) { warped.delete(); return { ok: false, error: 'Unknown sheet layout ' + qr.layout }; }

    // Black-and-white scans (scanner "B&W"/"Text" mode) keep no grey: the printed bubble outlines and
    // any faint or half-pressure mark are thresholded away before we see them, so a faint answer
    // would read as blank with nothing to flag it. Measured on test data: B&W scans 0.7-1.1% mid-grey
    // pixels, grayscale scans 2.9-7.2%, phone photos 6.4%+.
    let mid = 0, nmid = 0;
    { const W = warped.cols, H = warped.rows, m = 25 * L.pxPerMm, g = warped.data;
      for (let y = m; y < H - m; y += 3) for (let x = m; x < W - m; x += 3) { const v = g[y * W + x]; nmid++; if (v > 70 && v < 190) mid++; } }
    const bw = mid / Math.max(1, nmid) < opts.bwMaxMid;
    if (bw && !opts.allowBW) {
      warped.delete();
      return { ok: false, bw: true, error: 'Scanned in black-and-white — faint marks are lost in this mode. Rescan in Grayscale or Colour (200–300 dpi)' };
    }

    const dark = normalise(cv, warped);

    // Verify the warp: all four markers must be solid where the layout puts them.
    const ppm = L.pxPerMm;
    const patch = (xmm, ymm, rmm) => {
      let sum = 0, n = 0;
      const r = Math.round(rmm * ppm), cx = Math.round(xmm * ppm), cy = Math.round(ymm * ppm);
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) { sum += dark.data[y * dark.cols + x]; n++; }
      return sum / n / 255;
    };
    const mk = OMRLayout.markerCenters(L);
    const markerDark = mk.map(([x, y], i) => (i === 0 ? Math.min(patch(x - 3.6, y, 1), patch(x + 3.6, y, 1), patch(x, y - 3.6, 1)) : patch(x, y, 2.5)));
    if (Math.min(...markerDark) < 0.45) {
      dark.delete(); warped.delete();
      return { ok: false, error: 'Could not line the sheet up — keep all four squares fully in view and retake' };
    }

    // Enrollment block
    const e = L.enrollment;
    const enrB = [];
    for (let c = 0; c < e.digits; c++) for (let d = 0; d <= 9; d++) enrB.push(OMRLayout.enrollmentBubble(L, c, d));
    // B&W scans have no printed outlines to align on; a flatbed scan is geometrically exact, so the
    // marker-based warp is used as is.
    const noShift = { dx: 0, dy: 0, s: undefined };
    const eOff = bw ? noShift : blockOffset(dark, L, enrB);
    // Answer columns
    const a = L.answers;
    const colOff = [];
    for (let c = 0; c < a.columns; c++) {
      const bs = [];
      for (let q = c * a.rowsPerColumn; q < Math.min(qr.nq, (c + 1) * a.rowsPerColumn); q++)
        for (let k = 0; k < a.options.length; k++) bs.push(OMRLayout.answerBubble(L, q, k));
      colOff.push(bs.length && !bw ? blockOffset(dark, L, bs) : { dx: 0, dy: 0, s: undefined });
    }
    // Printed circle outlines must be found for every block; a weak ring score means
    // the grid is not where the layout expects it (bent sheet, wrong warp) — never guess.
    const ringScores = [eOff.s].concat(colOff.map((o) => o.s)).filter((v) => v !== undefined);
    const ringMax = Math.max(...ringScores);
    if (!bw && ringScores.some((v) => v < opts.minRing || v < 0.45 * ringMax)) {
      dark.delete(); warped.delete();
      return { ok: false, error: 'Bubble grid not aligned — flatten the sheet and retake', ringScores };
    }
    const shift = (b, o) => ({ x: b.x + o.dx, y: b.y + o.dy, r: b.r });

    const all = [];
    const enrScores = [];
    for (let c = 0; c < e.digits; c++) {
      const s = [];
      for (let d = 0; d <= 9; d++) s.push(bubbleDarkness(dark, L, shift(OMRLayout.enrollmentBubble(L, c, d), eOff), opts.sampleR));
      enrScores.push(s); all.push(...s);
    }
    const ansScores = [];
    for (let q = 0; q < qr.nq; q++) {
      const o = colOff[Math.floor(q / a.rowsPerColumn)];
      const s = a.options.map((_, k) => bubbleDarkness(dark, L, shift(OMRLayout.answerBubble(L, q, k), o), opts.sampleR));
      ansScores.push(s); all.push(...s);
    }
    dark.delete();
    const base = median(all); // most bubbles on a sheet are empty

    const enrItems = enrScores.map((s, c) => Object.assign({ col: c }, classify(s, base, opts)));
    const enrollment = enrItems.map((it) => (it.state === 'marked' ? String(it.choice) : it.state === 'multiple' ? '*' : it.state === 'blank' ? '_' : '?')).join('');
    const items = ansScores.map((s, q) => Object.assign({ q: q + 1 }, classify(s, base, opts)));
    const answers = items.map((it) => (it.state === 'marked' ? a.options[it.choice] : it.state === 'blank' ? '-' : it.state === 'multiple' ? '*' : '?')).join('');
    const uncertain = items.filter((i) => i.state === 'uncertain').length + enrItems.filter((i) => i.state !== 'marked').length;

    return { ok: true, bw, qr, layout: L, corners: det.corners, enrollment, enrItems, answers, items, uncertain,
      offsets: { enrollment: eOff, columns: colOff }, ringScores, baseline: Math.round(base * 100) / 100, warped };
  }

  return { DEFAULTS, rgbaToGray, sharpness, detectMarkers, warpToCanonical, recognize };
});
