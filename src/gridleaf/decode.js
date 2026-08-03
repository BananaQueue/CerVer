import { SPACE, gridCells, refPoints, disc } from './mask.js';
import { COLS, bitsToPayload } from './codec.js';

// GridLeaf decoder.
//
// Locating is fundamentally easier than the dot-based design: the leaf OUTLINE
// is one large connected dark stroke, so it is found as the biggest blob rather
// than competing with the data for "largest". Four reference points on it (tip,
// base, widest-left, widest-right) give a PROJECTIVE fit, which corrects
// perspective as well as rotation/scale/shear.
//
// Never throws; every failure path returns null.

function toGray(img) {
  const { width: w, height: h, data } = img;
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    g[i] = (data[o] * 0.3 + data[o + 1] * 0.59 + data[o + 2] * 0.11) | 0;
  }
  return g;
}

function otsu(g) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const total = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let max = -1;
  let thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) {
      max = between;
      thr = i;
    }
  }
  return thr;
}

// Largest 8-connected dark component, returned as its member pixel coordinates.
function largestComponent(bin, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  let best = null;
  for (let start = 0; start < w * h; start++) {
    if (bin[start] === 0 || label[start] !== -1) continue;
    const id = start;
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    const pts = [];
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w;
      const py = (p / w) | 0;
      pts.push(px, py);
      for (let ny = py > 0 ? py - 1 : 0; ny <= (py < h - 1 ? py + 1 : h - 1); ny++) {
        for (let nx = px > 0 ? px - 1 : 0; nx <= (px < w - 1 ? px + 1 : w - 1); nx++) {
          const q = ny * w + nx;
          if (bin[q] === 1 && label[q] === -1) {
            label[q] = id;
            stack[sp++] = q;
          }
        }
      }
    }
    if (!best || pts.length > best.length) best = pts;
  }
  return best;
}

// Solve the 8 unknowns of a projective map from 4 src -> 4 dst point pairs.
function solveHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  // Gaussian elimination with partial pivoting on the 8x8 system.
  const n = 8;
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    if (Math.abs(A[piv][i]) < 1e-9) return null;
    [A[i], A[piv]] = [A[piv], A[i]];
    [b[i], b[piv]] = [b[piv], b[i]];
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      if (!f) continue;
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const h = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * h[c];
    h[i] = s / A[i][i];
  }
  if (h.some((v) => !Number.isFinite(v))) return null;
  return (p) => {
    const d = h[6] * p.x + h[7] * p.y + 1;
    if (Math.abs(d) < 1e-12) return null;
    return { x: (h[0] * p.x + h[1] * p.y + h[2]) / d, y: (h[3] * p.x + h[4] * p.y + h[5]) / d };
  };
}

// Recover tip / stem-end / widest-left / widest-right from the mark's pixels.
//
// No principal-axis estimate is used: this leaf is nearly as wide as it is long
// (860 x 960 canonical), so second-moment axis detection is ill-conditioned.
// Instead the TIP is simply the farthest pixel from the centroid — by
// construction it is farther than the widest points or the stem end — and the
// axis follows from centroid -> tip.
function outlineRefs(pts) {
  const n = pts.length / 2;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[i * 2];
    cy += pts[i * 2 + 1];
  }
  cx /= n;
  cy /= n;

  // The STEM END is the farthest point of the mark from its centroid — the leaf
  // sits high in its box precisely so the stem out-reaches both the tip and the
  // widest points, giving an unambiguous anchor. (Anchoring on the tip instead
  // failed: on a broad leaf the tip and the widest points are nearly equidistant
  // from the centroid, so pixel noise picked the wrong one at low resolution.)
  //
  // Extremes are averaged over the top few candidates rather than taken from a
  // single argmax pixel, so one ragged edge pixel cannot skew the fit.
  const extremeOf = (score) => {
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(i);
    idx.sort((a, b) => score(b) - score(a));
    const k = Math.max(1, Math.min(6, Math.floor(n * 0.002) || 1));
    let sx = 0;
    let sy = 0;
    for (let j = 0; j < k; j++) {
      sx += pts[idx[j] * 2];
      sy += pts[idx[j] * 2 + 1];
    }
    return { x: sx / k, y: sy / k };
  };

  const distSq = (i) => {
    const dx = pts[i * 2] - cx;
    const dy = pts[i * 2 + 1] - cy;
    return dx * dx + dy * dy;
  };
  const stemEnd = extremeOf(distSq);

  const alen = Math.hypot(stemEnd.x - cx, stemEnd.y - cy);
  if (alen < 4) return null;
  // Axis points from the stem end toward the tip (through the centroid).
  const ax = (cx - stemEnd.x) / alen;
  const ay = (cy - stemEnd.y) / alen;

  const along = (i) => (pts[i * 2] - cx) * ax + (pts[i * 2 + 1] - cy) * ay;
  const across = (i) => -(pts[i * 2] - cx) * ay + (pts[i * 2 + 1] - cy) * ax;
  const tip = extremeOf(along);
  const right = extremeOf(across);
  const left = extremeOf((i) => -across(i));
  if (!tip || !left || !right) return null;
  return { tip, stemEnd, left, right };
}

export function decode(img) {
  try {
    if (!img || !img.data || !img.width || !img.height) return null;
    const w = img.width | 0;
    const h = img.height | 0;
    if (w < 24 || h < 24 || img.data.length < w * h * 4) return null;

    const g = toGray(img);
    const thr = otsu(g);
    const bin = new Uint8Array(w * h);
    let darkCount = 0;
    for (let i = 0; i < w * h; i++) {
      if (g[i] <= thr) {
        bin[i] = 1;
        darkCount++;
      }
    }
    if (darkCount < 60) return null;

    const outline = largestComponent(bin, w, h);
    if (!outline || outline.length / 2 < 40) return null;
    const refs = outlineRefs(outline);
    if (!refs) return null;

    const { cells } = gridCells(COLS);
    const d = disc(COLS);

    // A disc is rotationally symmetric, so it has no distinctive "tip": every
    // boundary point is equidistant from the centre and an extremal-point fit is
    // unstable (measured 31 px off). What a disc DOES give, robustly, is a
    // centre, a radius and — via the tab — a rotation. That is a similarity
    // transform, estimated from the two widest points (which are stable) rather
    // than from four noisy corners.
    const cxImg = (refs.left.x + refs.right.x) / 2;
    const cyImg = (refs.left.y + refs.right.y) / 2;
    const rImg = Math.hypot(refs.right.x - refs.left.x, refs.right.y - refs.left.y) / 2;
    if (!(rImg > 4)) return null;
    const scale = rImg / d.rOuter;
    // Sample window sized to the cell, clamped so it never spills into neighbours.
    const cellImg = (SPACE / COLS) * scale;
    const sampleR = Math.max(1, Math.min(3, Math.round(cellImg * 0.25)));

    // Canonical "toward the tab" is +y; match it to the measured tab direction.
    const tabAng = Math.atan2(refs.stemEnd.y - cyImg, refs.stemEnd.x - cxImg);
    for (const flip of [false, true]) {
      const theta = tabAng - Math.PI / 2 + (flip ? Math.PI : 0);
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const map = (p) => {
        const dx = (p.x - d.cx) * scale;
        const dy = (p.y - d.cy) * scale;
        return { x: cxImg + dx * cosT - dy * sinT, y: cyImg + dx * sinT + dy * cosT };
      };
      const bits = new Uint8Array(cells.length);
      let ok = true;
      for (let i = 0; i < cells.length; i++) {
        const q = map({ x: cells[i].x, y: cells[i].y });
        if (!q) { ok = false; break; }
        const x = Math.round(q.x);
        const y = Math.round(q.y);
        if (x < 0 || y < 0 || x >= w || y >= h) { bits[i] = 0; continue; }
        // Average over a window scaled to the CELL, not a fixed 3x3. A fixed
        // window aliases badly at some scales (measured: 400 px and 240 px
        // decoded but 300 px did not) because the sampled pixels drift toward
        // the cell boundary as the scale changes.
        let sum = 0;
        let cnt = 0;
        for (let dy = -sampleR; dy <= sampleR; dy++)
          for (let dx = -sampleR; dx <= sampleR; dx++) {
            if (dx * dx + dy * dy > sampleR * sampleR) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            sum += g[ny * w + nx];
            cnt++;
          }
        bits[i] = cnt && sum / cnt <= thr ? 1 : 0;
      }
      if (!ok) continue;
      const payload = bitsToPayload(bits);
      if (payload) return payload;
    }
    return null;
  } catch {
    return null;
  }
}
