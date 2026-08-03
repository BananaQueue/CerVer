import { N, GRID, CARRIERS, FIXED, INK_BBOX } from './baseline.js';
import { bitsToPayload } from './payload.js';

// EMB seal code — decoder.
//
// Locating is done by the artwork itself. The mark is one large connected dark
// region whose bounding box gives position and scale. Rotation is recovered by
// matching the FIXED tiles (every tile that can never carry data — the disc rim,
// the tree, the band edges) against the frozen baseline: the correct angle is
// the one where ~1600 fixed tiles agree. That same score doubles as proof we are
// looking at an EMB seal at all, so a random dark blob is rejected rather than
// decoded into nonsense.
//
// Never throws; every failure returns null.

// Centred tile coordinates of every inked baseline tile, used to predict the
// mark's bounding box at any rotation.
const INK_PTS = (() => {
  const a = [];
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++)
      if (GRID[r][c] === '1') { a.push(c + 0.5 - N / 2, r + 0.5 - N / 2); }
  return Float64Array.from(a);
})();

const MIN_FIXED_MATCH = 0.86; // fraction of fixed tiles that must agree

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
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, max = -1, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = g.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; thr = i; }
  }
  return thr;
}

/**
 * Bounding box of the mark.
 *
 * The seal is several disconnected shapes — the field with the tree cut out of
 * it, and each band on its own — so the largest single component would box only
 * part of it. But taking every dark pixel is wrong too: on a real page the mark
 * sits beside body text and a footer line, and those would be swallowed into the
 * box, throwing off scale and centre.
 *
 * So: take every component that is a substantial fraction of the largest one and
 * union those. The seal's bands clear that bar easily; text glyphs do not.
 */
const MIN_PART = 0.02; // component must be >= 2% of the largest to count

function markBounds(bin, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const parts = [];
  for (let start = 0; start < w * h; start++) {
    if (bin[start] === 0 || label[start] !== -1) continue;
    let sp = 0, area = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    stack[sp++] = start;
    label[start] = start;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w, py = (p / w) | 0;
      area++;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      for (let ny = py > 0 ? py - 1 : 0; ny <= (py < h - 1 ? py + 1 : h - 1); ny++)
        for (let nx = px > 0 ? px - 1 : 0; nx <= (px < w - 1 ? px + 1 : w - 1); nx++) {
          const q = ny * w + nx;
          if (bin[q] === 1 && label[q] === -1) { label[q] = start; stack[sp++] = q; }
        }
    }
    parts.push({ area, minX, minY, maxX, maxY });
  }
  if (!parts.length) return null;

  let biggest = parts[0];
  for (const p of parts) if (p.area > biggest.area) biggest = p;
  const cutoff = biggest.area * MIN_PART;

  let minX = w, minY = h, maxX = -1, maxY = -1, area = 0;
  for (const p of parts) {
    if (p.area < cutoff) continue;
    area += p.area;
    if (p.minX < minX) minX = p.minX;
    if (p.maxX > maxX) maxX = p.maxX;
    if (p.minY < minY) minY = p.minY;
    if (p.maxY > maxY) maxY = p.maxY;
  }
  return maxX < 0 ? null : { area, minX, minY, maxX, maxY };
}

function decodeCore(img) {
  try {
    const NO = { payload: null, score: 0, deg: 0, pitch: 0 };
    if (!img || !img.data || !img.width || !img.height) return NO;
    const w = img.width | 0, h = img.height | 0;
    if (w < 40 || h < 40 || img.data.length < w * h * 4) return NO;

    const g = toGray(img);
    const thr = otsu(g);
    const bin = new Uint8Array(w * h);
    let dark = 0;
    for (let i = 0; i < w * h; i++) if (g[i] <= thr) { bin[i] = 1; dark++; }
    if (dark < 200) return NO;

    const bb = markBounds(bin, w, h);
    if (!bb || bb.maxX < 0) return NO;
    const side = Math.max(bb.maxX - bb.minX + 1, bb.maxY - bb.minY + 1);
    if (side < INK_BBOX.cols) return NO; // fewer than one pixel per tile

    const obsW = bb.maxX - bb.minX + 1;
    const obsH = bb.maxY - bb.minY + 1;
    const obsCx = (bb.minX + bb.maxX) / 2;
    const obsCy = (bb.minY + bb.maxY) / 2;

    // Scale and position depend on the rotation: a rotated mark has a larger
    // bounding box than an upright one, so a single bbox-derived pitch is only
    // right at multiples of 90 degrees. Instead, for each candidate angle,
    // compute what box the baseline artwork WOULD occupy at that angle, and
    // derive pitch and centre from the ratio.
    const fitFor = (cos, sin, k = 1) => {
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (let i = 0; i < INK_PTS.length; i += 2) {
        const gx = INK_PTS[i], gy = INK_PTS[i + 1];
        const x = gx * cos - gy * sin;
        const y = gx * sin + gy * cos;
        if (x < mnx) mnx = x;
        if (x > mxx) mxx = x;
        if (y < mny) mny = y;
        if (y > mxy) mxy = y;
      }
      // +1 because INK_PTS holds tile CENTRES: the centres span one tile less
      // than the ink itself does, and the observed box measures ink edge to edge.
      const pitch = k * Math.max(obsW / (mxx - mnx + 1), obsH / (mxy - mny + 1));
      return { pitch, offX: ((mnx + mxx) / 2) * pitch, offY: ((mny + mxy) / 2) * pitch };
    };

    // Sample tile (r,c) under a given rotation and fit.
    const sampleAt = (r, c, cos, sin, fit) => {
      const gx0 = c + 0.5 - N / 2;
      const gy0 = r + 0.5 - N / 2;
      const gx = (gx0 * cos - gy0 * sin) * fit.pitch;
      const gy = (gx0 * sin + gy0 * cos) * fit.pitch;
      // Sub-pixel bilinear sample at the tile centre.
      //
      // Averaging a fixed 3x3 window was the wrong approach: on a page rendered
      // at ~4 px per tile that window spans most of the tile and blends in its
      // neighbours, which measured a 5.8% misread rate — far too high, since a
      // single bad bit ruins a whole Reed-Solomon byte. Reading the centre at
      // sub-pixel precision keeps the sample inside the tile it belongs to.
      const fx = obsCx - fit.offX + gx;
      const fy = obsCy - fit.offY + gy;
      if (fx < 0 || fy < 0 || fx >= w - 1 || fy >= h - 1) return 0;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const ax = fx - x0, ay = fy - y0;
      const v =
        g[y0 * w + x0] * (1 - ax) * (1 - ay) +
        g[y0 * w + x0 + 1] * ax * (1 - ay) +
        g[(y0 + 1) * w + x0] * (1 - ax) * ay +
        g[(y0 + 1) * w + x0 + 1] * ax * ay;
      return v <= thr ? 1 : 0;
    };

    // Score a candidate rotation on the fixed tiles only.
    const score = (deg, k = 1) => {
      const t = (deg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
      const fit = fitFor(cos, sin, k);
      let ok = 0;
      for (let i = 0; i < FIXED.length; i++) {
        const f = FIXED[i];
        if (sampleAt(f[0], f[1], cos, sin, fit) === f[2]) ok++;
      }
      return ok / FIXED.length;
    };

    // Coarse sweep then refine. The artwork is strongly asymmetric, so the true
    // angle stands well clear of the others.
    let bestDeg = 0, bestK = 1, bestScore = -1;
    for (let d = 0; d < 360; d += 5) {
      const s = score(d);
      if (s > bestScore) { bestScore = s; bestDeg = d; }
    }
    // Refine angle AND scale together. The bounding box under-determines pitch
    // near diagonal angles, where the mark's silhouette is least square, so a
    // small scale correction is searched alongside the angle.
    const deg0 = bestDeg;
    for (let d = deg0 - 4; d <= deg0 + 4; d += 1) {
      for (let k = 0.97; k <= 1.0301; k += 0.005) {
        const s = score(d, k);
        if (s > bestScore) { bestScore = s; bestDeg = d; bestK = k; }
      }
    }
    if (bestScore < MIN_FIXED_MATCH) return { payload: null, score: bestScore, deg: bestDeg, pitch: fitFor(Math.cos(bestDeg*Math.PI/180), Math.sin(bestDeg*Math.PI/180), bestK).pitch };

    const t = (bestDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    const fit = fitFor(cos, sin, bestK);
    const bits = new Uint8Array(CARRIERS.length);
    for (let i = 0; i < CARRIERS.length; i++) {
      bits[i] = sampleAt(CARRIERS[i][0], CARRIERS[i][1], cos, sin, fit);
    }
    return { payload: bitsToPayload(bits), score: bestScore, deg: bestDeg, pitch: fit.pitch };
  } catch {
    return { payload: null, score: 0, deg: 0, pitch: 0 };
  }
}

export function decode(img) {
  return decodeCore(img).payload;
}

/** Diagnostic: best fixed-tile match, recovered angle and tile pitch. */
export function inspect(img) {
  return decodeCore(img);
}
