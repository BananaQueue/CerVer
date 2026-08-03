import { N, GRID, CARRIERS, FIXED, INK_BBOX } from './baseline.js';
import { bitsToPayload } from '../gridleaf/codec.js';

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
 * Bounding box of ALL dark pixels.
 *
 * Deliberately not the largest connected component: the seal is several
 * separate shapes — the blue mass with the tree cut out of it, and each band
 * on its own — so taking one component would box only part of the mark. A
 * wrong box is harmless because the fixed-tile score below rejects it.
 */
function markBounds(bin, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1, area = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bin[y * w + x]) continue;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { area, minX, minY, maxX, maxY };
}

export function decode(img) {
  try {
    if (!img || !img.data || !img.width || !img.height) return null;
    const w = img.width | 0, h = img.height | 0;
    if (w < 40 || h < 40 || img.data.length < w * h * 4) return null;

    const g = toGray(img);
    const thr = otsu(g);
    const bin = new Uint8Array(w * h);
    let dark = 0;
    for (let i = 0; i < w * h; i++) if (g[i] <= thr) { bin[i] = 1; dark++; }
    if (dark < 200) return null;

    const bb = markBounds(bin, w, h);
    if (!bb || bb.maxX < 0) return null;
    const side = Math.max(bb.maxX - bb.minX + 1, bb.maxY - bb.minY + 1);
    if (side < INK_BBOX.cols) return null; // fewer than one pixel per tile

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
      const sampleR = Math.max(0, Math.floor(fit.pitch * 0.28));
      const x = Math.round(obsCx - fit.offX + gx);
      const y = Math.round(obsCy - fit.offY + gy);
      if (x < 0 || y < 0 || x >= w || y >= h) return 0;
      let sum = 0, n = 0;
      for (let dy = -sampleR; dy <= sampleR; dy++)
        for (let dx = -sampleR; dx <= sampleR; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          sum += g[ny * w + nx];
          n++;
        }
      return n && sum / n <= thr ? 1 : 0;
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
    if (bestScore < MIN_FIXED_MATCH) return null; // not an EMB seal

    const t = (bestDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    const fit = fitFor(cos, sin, bestK);
    const bits = new Uint8Array(CARRIERS.length);
    for (let i = 0; i < CARRIERS.length; i++) {
      bits[i] = sampleAt(CARRIERS[i][0], CARRIERS[i][1], cos, sin, fit);
    }
    return bitsToPayload(bits);
  } catch {
    return null;
  }
}

/** Diagnostic: how well an image matches the seal's fixed structure. */
export function structureScore(img) {
  const before = decode(img);
  return before === null ? 0 : 1;
}
