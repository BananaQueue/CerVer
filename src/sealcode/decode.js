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

// The fixed tiles are scored in three groups, and the match is the WORST of the
// three rates. A single pooled agreement count is worthless here, for two
// compounding reasons:
//
//   1186 of the 1631 fixed tiles are expected BARE, so a pooled count hands any
//   mostly-white frame 0.727 before it has seen anything — and a camera pointed
//   at blank paper always has some incidental ink in view, so it cleared that
//   floor and the scan reported a seal that was not there.
//
//   Of those bare tiles, 1047 are the field surrounding the mark and only 139
//   are holes in the artwork itself — the tree, the gaps between the bands. The
//   surrounding field is free for anything disc-shaped, and the seal IS a disc,
//   so a dark blob scored 0.67 on the outline alone. The holes are where the
//   artwork is actually distinguishable, and they are outnumbered 8:1.
//
// Splitting them makes each necessary: bare paper fails ON, a filled blob fails
// HOLE, ink bleeding past the rim fails FIELD, and only the artwork passes all
// three.
const isInterior = (r, c) => {
  const at = (y, x) => (y < 0 || x < 0 || y >= N || x >= N ? 0 : GRID[y][x] === '1' ? 1 : 0);
  let up = 0, dn = 0, lf = 0, rt = 0;
  for (let i = 0; i < r; i++) if (at(i, c)) up = 1;
  for (let i = r + 1; i < N; i++) if (at(i, c)) dn = 1;
  for (let j = 0; j < c; j++) if (at(r, j)) lf = 1;
  for (let j = c + 1; j < N; j++) if (at(r, j)) rt = 1;
  return up && dn && lf && rt;
};
const FIXED_ON = FIXED.filter((f) => f[2] === 1);
const FIXED_HOLE = FIXED.filter((f) => f[2] === 0 && isInterior(f[0], f[1]));
const FIXED_FIELD = FIXED.filter((f) => f[2] === 0 && !isInterior(f[0], f[1]));

const MIN_FIXED_MATCH = 0.72; // every group must reach this

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
 * Candidate bounding boxes for the mark.
 *
 * The seal is several disconnected shapes — the field with the tree cut out of
 * it, and each band on its own — so the largest single component boxes only part
 * of it. Unioning every substantial component fixes that when the mark is alone
 * in frame, but on a real page it is not: a photo of the calibration sheet put
 * the caption "18 mm · 0.41 mm per tile" a few millimetres under the seal, the
 * union stretched the box from 500 px to 760 px, and the pitch came out 17.3
 * px per tile instead of 11. Everything downstream is derived from that box, so
 * the whole read was lost — with the mark perfectly framed and sharp.
 *
 * There is no local rule that reliably tells the seal's own bands from a line of
 * text sitting under it. So rather than pick one box and hope, offer a few and
 * let the fixed-tile matcher decide: only the box that actually frames the
 * artwork scores, and the score is already the thing that proves it is a seal.
 */
const MIN_PART = 0.02; // component must be >= 2% of the largest to count

// How much of a part must fall inside the anchor's box to count as belonging to
// the same mark. The seal's bands sit inside the disc; a caption underneath it
// does not.
const INSIDE = 0.6;

function markCandidates(bin, w, h) {
  const parts = componentsOf(bin, w, h);
  if (!parts.length) return [];

  let biggest = parts[0];
  for (const p of parts) if (p.area > biggest.area) biggest = p;
  const cutoff = biggest.area * MIN_PART;
  const big = parts.filter((p) => p.area >= cutoff);

  const box = (list) => {
    let minX = w, minY = h, maxX = -1, maxY = -1, area = 0;
    for (const p of list) {
      area += p.area;
      if (p.minX < minX) minX = p.minX;
      if (p.maxX > maxX) maxX = p.maxX;
      if (p.minY < minY) minY = p.minY;
      if (p.maxY > maxY) maxY = p.maxY;
    }
    return maxX < 0 ? null : { area, minX, minY, maxX, maxY };
  };

  // Fraction of `p`'s box area lying inside `a`'s box.
  const containment = (p, a) => {
    const ox = Math.min(p.maxX, a.maxX) - Math.max(p.minX, a.minX) + 1;
    const oy = Math.min(p.maxY, a.maxY) - Math.max(p.minY, a.minY) + 1;
    if (ox <= 0 || oy <= 0) return 0;
    return (ox * oy) / ((p.maxX - p.minX + 1) * (p.maxY - p.minY + 1));
  };

  const near = big.filter((p) => p === biggest || containment(p, biggest) >= INSIDE);

  // Grow a cluster out from the largest part, taking in whatever sits close to
  // what has been gathered so far. This is what actually separates the mark from
  // its surroundings: the seal's own pieces — the two halves of the tree, then
  // each band — are a pixel or three apart and chain together, while the caption
  // under the mark is tens of pixels clear and never joins. The tolerance is a
  // fraction of the cluster's own size, so it holds at any scale.
  const gapOf = (b) => Math.max(4, 0.15 * Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1));
  const cluster = [biggest];
  for (let grew = true; grew; ) {
    grew = false;
    const b = box(cluster);
    const gap = gapOf(b);
    for (const p of big) {
      if (cluster.includes(p)) continue;
      const dx = Math.max(0, Math.max(b.minX - p.maxX, p.minX - b.maxX));
      const dy = Math.max(0, Math.max(b.minY - p.maxY, p.minY - b.maxY));
      if (dx <= gap && dy <= gap) { cluster.push(p); grew = true; }
    }
  }

  const out = [];
  for (const c of [box(cluster), box(near), box(big), box([biggest])]) {
    if (!c) continue;
    if (!out.some((o) => o.minX === c.minX && o.minY === c.minY && o.maxX === c.maxX && o.maxY === c.maxY))
      out.push(c);
  }
  return out;
}

// Boxes with thin protrusions trimmed off.
//
// Every box above is an extent box, so anything that runs off the edge of the
// mark — a ballpen stroke across the page, a smudge — inflates all of them at
// once, and the artwork is then fitted to a rectangle the mark does not occupy.
// The mark tolerates ink ON it well (Reed-Solomon absorbs the damaged tiles); it
// is ink extending PAST it that cannot be recovered, because a misplaced box
// misreads every tile at once and no amount of parity covers that.
//
// What separates a stroke from the artwork is thickness: a pen line is about a
// tile wide, while the disc and bands run many tiles. So walk in from each edge
// while the longest ink run in that row or column is short, and stop where the
// artwork begins.
//
// Several thresholds are offered rather than one tuned value. The fixed-tile
// score already decides between candidates, so a wrong trim simply loses — and
// on real captures the workable band is narrow and moves with blur, which is
// exactly the thing not to hard-code.
//
// These are regions to look inside, not boxes to fit the artwork to. The stroke
// still crosses the rows the mark occupies, so the trimmed rectangle is only
// approximately the mark; what recovers the read is confining the ordinary
// component clustering to that region, where the stroke's remnant is no longer
// joined to anything that reaches the edge.
function trimBoxes(bin, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bin[y * w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return [];

  // Longest ink run per row and per column, measured once and reused by every
  // threshold, so offering more thresholds costs almost nothing.
  const rowRun = new Int32Array(h), colRun = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    let run = 0, best = 0;
    for (let x = 0; x < w; x++) {
      if (bin[y * w + x]) { if (++run > best) best = run; } else run = 0;
    }
    rowRun[y] = best;
  }
  for (let x = 0; x < w; x++) {
    let run = 0, best = 0;
    for (let y = 0; y < h; y++) {
      if (bin[y * w + x]) { if (++run > best) best = run; } else run = 0;
    }
    colRun[x] = best;
  }

  // A stroke inflates one axis and rarely both, so the SHORTER side of the ink
  // box is the more honest estimate of a tile. On the capture this was built
  // from, the box is 677x477 with the width inflated by the stroke, and
  // min(677,477)/44 lands on 10.8 px — the pitch the decoder goes on to recover.
  const tile = Math.min(maxX - minX + 1, maxY - minY + 1) / N;
  const out = [];
  for (const k of [1, 2, 3, 4, 5, 6, 8]) {
    const minRun = tile * k;
    let y0 = minY; while (y0 < maxY && rowRun[y0] < minRun) y0++;
    let y1 = maxY; while (y1 > y0 && rowRun[y1] < minRun) y1--;
    let x0 = minX; while (x0 < maxX && colRun[x0] < minRun) x0++;
    let x1 = maxX; while (x1 > x0 && colRun[x1] < minRun) x1--;
    if (x1 <= x0 || y1 <= y0) continue;
    // Trimmed nothing: the ordinary boxes already covered this.
    if (x0 === minX && y0 === minY && x1 === maxX && y1 === maxY) continue;
    if (out.some((o) => o.minX === x0 && o.minY === y0 && o.maxX === x1 && o.maxY === y1)) continue;
    out.push({ area: 0, minX: x0, minY: y0, maxX: x1, maxY: y1 });
  }
  return out;
}

function componentsOf(bin, w, h) {
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
  return parts;
}

/**
 * Per-pixel threshold from the mean of a surrounding box, via an integral image.
 *
 * One global threshold is right for a clean render and wrong for a photograph.
 * A phone shot of a page is lit unevenly — the sheet curls, a shadow crosses the
 * corner — and Otsu then splits light paper from dark paper instead of paper
 * from ink, which puts big patches of background into the mark's own component.
 * Measured against a real capture, switching to a local threshold lifted the
 * fixed-tile match from 94% to 99%.
 */
function localThreshold(g, w, h, radius, bias) {
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      ii[(y + 1) * (w + 1) + x + 1] =
        g[y * w + x] + ii[y * (w + 1) + x + 1] + ii[(y + 1) * (w + 1) + x] - ii[y * (w + 1) + x];

  const thr = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        ii[(y1 + 1) * (w + 1) + x1 + 1] - ii[y0 * (w + 1) + x1 + 1] -
        ii[(y1 + 1) * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
      thr[y * w + x] = sum / area - bias;
    }
  }
  return thr;
}

/** Copy of `img` bounded by `b`. */
function cropTo(img, b) {
  const w = b.maxX - b.minX + 1, h = b.maxY - b.minY + 1;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    let s = ((y + b.minY) * img.width + b.minX) * 4, d = y * w * 4;
    for (let x = 0; x < w; x++, s += 4, d += 4) {
      data[d] = img.data[s];
      data[d + 1] = img.data[s + 1];
      data[d + 2] = img.data[s + 2];
      data[d + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

// `depth` guards the retry below: the trimmed region is decoded by the same
// routine, and must not trim again.
function decodeCore(img, depth = 0) {
  try {
    const NO = { payload: null, score: 0, deg: 0, pitch: 0 };
    if (!img || !img.data || !img.width || !img.height) return NO;
    const w = img.width | 0, h = img.height | 0;
    if (w < 40 || h < 40 || img.data.length < w * h * 4) return NO;

    const g = toGray(img);

    // Two ways of deciding what is ink. Otsu is right on a clean render and is
    // tried first because it is cheap; the local threshold is what a photograph
    // needs. Whichever produces a clean read wins.
    const flat = otsu(g);
    const modes = [
      () => new Float64Array(w * h).fill(flat),
      () => localThreshold(g, w, h, Math.max(8, Math.round(Math.min(w, h) / 12)), 6),
    ];

    const wideEnough = (c) =>
      Math.max(c.maxX - c.minX + 1, c.maxY - c.minY + 1) >= INK_BBOX.cols;

    let best = NO;
    const binned = [];
    for (const makeThr of modes) {
      const thrMap = makeThr();
      const bin = new Uint8Array(w * h);
      let dark = 0;
      for (let i = 0; i < w * h; i++) if (g[i] <= thrMap[i]) { bin[i] = 1; dark++; }
      if (dark < 200) continue;
      binned.push({ bin, thrMap });

      for (const bb of markCandidates(bin, w, h).filter(wideEnough)) {
        const got = readFrom(bb, thrMap);
        if (got.score > best.score) best = got;
        if (got.payload) return got; // a clean read settles it
      }
    }

    // Nothing read from the extent boxes. Ink that runs off the edge of the mark
    // inflates every one of them at once, so try again with thin protrusions
    // trimmed away. Deliberately only on failure: pages without a stroke on them
    // never pay for this, and a page that has one has already produced nothing.
    // Re-run the whole pipeline on the trimmed region rather than just refitting
    // to it. Both halves matter: the clustering no longer sees the tail that ran
    // off the mark's edge, and the local threshold re-adapts to a window scaled
    // to the region instead of the whole frame. Refitting alone recovers part of
    // the loss and is not enough.
    if (depth === 0) {
      const seen = new Set();
      for (const { bin } of binned) {
        for (const t of trimBoxes(bin, w, h)) {
          const key = `${t.minX},${t.minY},${t.maxX},${t.maxY}`;
          if (seen.has(key)) continue; // the two threshold modes often agree
          seen.add(key);
          const got = decodeCore(cropTo(img, t), depth + 1);
          if (got.score > best.score) best = got;
          if (got.payload) return got;
        }
      }
    }
    return best;

    function readFrom(bb, thrMap) {
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
      // The threshold varies across a photograph, so it is read where the sample
      // was taken rather than shared by the whole frame.
      return v <= thrMap[(Math.round(fy) * w) + Math.round(fx)] ? 1 : 0;
    };

    // Score a candidate rotation on the fixed tiles only, as the worse of the
    // ink-tile and bare-tile agreement rates.
    const score = (deg, k = 1) => {
      const t = (deg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
      const fit = fitFor(cos, sin, k);
      const rate = (group, want) => {
        let ok = 0;
        for (let i = 0; i < group.length; i++) {
          const f = group[i];
          if (sampleAt(f[0], f[1], cos, sin, fit) === want) ok++;
        }
        return ok / group.length;
      };
      return Math.min(rate(FIXED_ON, 1), rate(FIXED_HOLE, 0), rate(FIXED_FIELD, 0));
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
    }
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
