// LeafCode image decoder: RGBA pixels in, payload string (or null) out.
//
// Pipeline
//   1. grayscale
//   2. Otsu global threshold -> binary (1 = dark mark, 0 = background)
//   3. 8-connected components -> blobs with area / centroid / bbox
//   4. anchor identification: the 3 anchors are the largest marks by pixel
//      area, but rather than trusting area alone we search 3-subsets of the
//      largest blobs and score each by how well its side lengths match the
//      canonical SCALENE anchor triangle (scale-normalised, so the score is
//      independent of image size)
//   5. anchor labelling: because the canonical triangle is scalene
//      (sides ~= 512.4, 224.0, 664.2 -- all distinct) exactly one assignment
//      of detected points to canonical labels preserves the side lengths, so
//      orientation is unambiguous
//   6. affine transform canonical -> image, solved exactly from the three
//      labelled correspondences
//   7. sample each of the 256 mapped node centres with a radius DERIVED from
//      the recovered scale, classify solid (bit 1) / hollow (bit 0)
//   8. hand the 256 bits to bitsToPayload (Reed-Solomon + header check),
//      which is also the final arbiter that the anchor fit was correct
//
// decode() never throws and never mutates the input image; every failure
// path returns null.

import { lattice, SPACE } from './lattice.js';
import { bitsToPayload } from './codec.js';

// --- Geometry constants mirrored from raster.js -----------------------------
// raster.js derives its default node radius as NODE_R_FACTOR * MIN_D * (px /
// SPACE). Those two factors are not exported (and raster.js must not be
// modified), so they are duplicated here as documented constants. Their
// product is the default node radius in CANONICAL units; multiplying by the
// scale recovered from the anchors gives the node radius in image pixels at
// whatever size the code was rendered.
const MIN_D = 24;
const NODE_R_FACTOR = 0.36;
const CANON_NODE_R = NODE_R_FACTOR * MIN_D; // 8.64 canonical units

// Fraction of the scaled node radius used as the sampling disc radius. The
// hollow (bit 0) ring leaves a white interior of 0.7 * nodeR, so anything
// below 0.7 stays clear of the ring edge; 0.35 keeps a 2x margin at every
// canvas size (px=1000: sample 3.02 vs white 6.05; px=800: 2.42 vs 4.84).
const SAMPLE_R_FACTOR = 0.35;

// Radius (as a fraction of the scaled node radius) at which a mark must be
// dark for BOTH bit values: a solid disc is dark out to 1.0 * nodeR and a
// hollow ring is dark from 0.7 to 1.0 * nodeR, so 0.85 is inside the ink of
// either. Used to verify a candidate anchor fit actually lands on marks.
const PRESENCE_R_FACTOR = 0.85;

// How many of the largest blobs to consider as anchor candidates. The three
// anchors are the largest marks by area, but this leaves headroom for a data
// dot rendering oversized (blur, ink spread) and displacing one of them.
const ANCHOR_POOL = 14;

// Candidate fits to keep after ranking, and how many to actually run the
// Reed-Solomon decode on.
const MAX_CANDIDATES = 12;
const MAX_RS_ATTEMPTS = 6;

// A candidate fit must land on real marks at least this often to be worth a
// Reed-Solomon attempt.
const MIN_PRESENCE = 0.6;

// Minimum blob area in pixels. Below this a component is noise, not a mark.
const MIN_BLOB_AREA = 6;

function dist(p, q) {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

function toGray(img) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const g = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    g[i] = (data[o] * 0.3 + data[o + 1] * 0.59 + data[o + 2] * 0.11) | 0;
  }
  return g;
}

// Otsu's method: the threshold maximising between-class variance. The value
// returned is the INCLUSIVE upper bound of the dark class, so callers must
// binarise with `v <= thr`, not `v < thr`. On a perfectly bimodal image (the
// rasterizer emits only 0 and 255) the optimum split is at level 0, and a
// strict `<` comparison would classify nothing at all as dark.
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

// 8-connected components of the dark (bin === 1) pixels. Iterative flood fill
// over a typed-array stack so a pathological image cannot blow the JS stack.
function components(bin, w, h) {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const blobs = [];
  for (let start = 0; start < n; start++) {
    if (bin[start] === 0 || label[start] !== -1) continue;
    const id = blobs.length;
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    let area = 0;
    let sx = 0;
    let sy = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w;
      const py = (p / w) | 0;
      area++;
      sx += px;
      sy += py;
      const y0 = py > 0 ? py - 1 : 0;
      const y1 = py < h - 1 ? py + 1 : h - 1;
      const x0 = px > 0 ? px - 1 : 0;
      const x1 = px < w - 1 ? px + 1 : w - 1;
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) {
          const q = ny * w + nx;
          if (bin[q] === 1 && label[q] === -1) {
            label[q] = id;
            stack[sp++] = q;
          }
        }
      }
    }
    blobs.push({
      area,
      x: sx / area,
      y: sy / area,
    });
  }
  return blobs;
}

// Exact affine map from the src triangle onto the dst triangle.
//
// Writing p - s0 = M * [u, v]^T with M = [[s1x-s0x, s2x-s0x],
//                                         [s1y-s0y, s2y-s0y]],
// the barycentric-style coordinates are [u, v]^T = M^-1 * (p - s0), and the
// image point is d0 + u*(d1-d0) + v*(d2-d0). M^-1 = (1/det) * [[ d, -b],
//                                                              [-c,  a]]
// for M = [[a, b], [c, d]] -- note the OFF-DIAGONAL terms are -b and -c, i.e.
// -(s2x-s0x) in the top row and -(s1y-s0y) in the bottom row. (The task brief
// had these two swapped, which transposes the inverse and silently produces a
// wrong map for any non-symmetric triangle.)
function solveAffine(src, dst) {
  const [s0, s1, s2] = src;
  const [d0, d1, d2] = dst;
  const a = s1.x - s0.x;
  const b = s2.x - s0.x;
  const c = s1.y - s0.y;
  const d = s2.y - s0.y;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  const m11 = d * inv;
  const m12 = -b * inv;
  const m21 = -c * inv;
  const m22 = a * inv;
  const e1x = d1.x - d0.x;
  const e1y = d1.y - d0.y;
  const e2x = d2.x - d0.x;
  const e2y = d2.y - d0.y;
  return (p) => {
    const dx = p.x - s0.x;
    const dy = p.y - s0.y;
    const u = m11 * dx + m12 * dy;
    const v = m21 * dx + m22 * dy;
    return { x: d0.x + u * e1x + v * e2x, y: d0.y + u * e1y + v * e2y };
  };
}

const PERMS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

// Label three detected points against the canonical anchors.
//
// The canonical anchor triangle is scalene -- its three side lengths
// (~512.4, ~224.0, ~664.2) are pairwise distinct -- so at most ONE of the six
// vertex assignments can reproduce those side lengths (up to a uniform
// scale). We try all six, normalise by the recovered scale so the comparison
// is scale-invariant, and return the best assignment together with its
// residual error and scale. A large error means these three blobs are not the
// anchors at all.
function labelAnchors(trio, canon) {
  const c01 = dist(canon[0], canon[1]);
  const c12 = dist(canon[1], canon[2]);
  const c20 = dist(canon[2], canon[0]);
  const cSum = c01 + c12 + c20;
  if (!(cSum > 0)) return null;

  let best = null;
  for (const perm of PERMS) {
    const p0 = trio[perm[0]];
    const p1 = trio[perm[1]];
    const p2 = trio[perm[2]];
    const d01 = dist(p0, p1);
    const d12 = dist(p1, p2);
    const d20 = dist(p2, p0);
    const dSum = d01 + d12 + d20;
    if (!(dSum > 0) || !Number.isFinite(dSum)) continue;
    const scale = dSum / cSum;
    const err =
      (Math.abs(d01 - scale * c01) +
        Math.abs(d12 - scale * c12) +
        Math.abs(d20 - scale * c20)) /
      dSum;
    if (best === null || err < best.err) {
      best = {
        err,
        scale,
        points: [
          { x: p0.x, y: p0.y },
          { x: p1.x, y: p1.y },
          { x: p2.x, y: p2.y },
        ],
      };
    }
  }
  return best;
}

// All 3-subsets of the first `k` items.
function trios(list) {
  const out = [];
  const k = list.length;
  for (let i = 0; i < k - 2; i++)
    for (let j = i + 1; j < k - 1; j++)
      for (let m = j + 1; m < k; m++) out.push([list[i], list[j], list[m]]);
  return out;
}

// Fraction of dark pixels inside a disc of radius r around (cx, cy).
function darkFraction(bin, w, h, cx, cy, r) {
  const ri = Math.max(0, Math.ceil(r));
  const r2 = r * r;
  let dark = 0;
  let total = 0;
  const bx = Math.round(cx);
  const by = Math.round(cy);
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dx = -ri; dx <= ri; dx++) {
      if (dx * dx + dy * dy > r2 && !(dx === 0 && dy === 0)) continue;
      const x = bx + dx;
      const y = by + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      total++;
      if (bin[y * w + x] === 1) dark++;
    }
  }
  return total === 0 ? 0 : dark / total;
}

// Is there ink around this point at the radius where BOTH a solid disc and a
// hollow ring are dark? Eight probes on the circle; majority wins.
const PROBE_COS = [];
const PROBE_SIN = [];
for (let i = 0; i < 8; i++) {
  PROBE_COS.push(Math.cos((i * Math.PI) / 4));
  PROBE_SIN.push(Math.sin((i * Math.PI) / 4));
}
function markPresent(bin, w, h, cx, cy, r) {
  let hits = 0;
  for (let i = 0; i < 8; i++) {
    const x = Math.round(cx + r * PROBE_COS[i]);
    const y = Math.round(cy + r * PROBE_SIN[i]);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    if (bin[y * w + x] === 1) hits++;
  }
  return hits >= 4;
}

function validImage(img) {
  if (!img || typeof img !== 'object') return false;
  const { width, height, data } = img;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  if (width <= 0 || height <= 0) return false;
  if (width * height > 40e6) return false; // refuse absurd allocations
  if (!ArrayBuffer.isView(data)) return false;
  if (data.length < width * height * 4) return false;
  return true;
}

export function decode(img) {
  try {
    if (!validImage(img)) return null;
    const w = img.width;
    const h = img.height;

    const gray = toGray(img);
    const thr = otsu(gray);
    const n = w * h;
    const bin = new Uint8Array(n);
    let darkCount = 0;
    for (let i = 0; i < n; i++) {
      if (gray[i] <= thr) {
        bin[i] = 1;
        darkCount++;
      }
    }
    // A blank page has nothing to find; a page that is almost entirely dark is
    // not a LeafCode either (and would produce one giant useless blob).
    if (darkCount < 3 * MIN_BLOB_AREA) return null;
    if (darkCount > n * 0.9) return null;

    const blobs = components(bin, w, h).filter((b) => b.area >= MIN_BLOB_AREA);
    if (blobs.length < 3) return null;

    const L = lattice();
    const canon = L.anchors;

    // Anchor candidates: the largest blobs by area. Ranking by area rather
    // than filtering by it keeps the search tolerant of one oversized data
    // dot -- the side-length match below decides which trio is really the
    // anchor triangle.
    const pool = blobs
      .slice()
      .sort((a, b) => b.area - a.area)
      .slice(0, ANCHOR_POOL);

    const candidates = [];
    for (const trio of trios(pool)) {
      const lab = labelAnchors(trio, canon);
      if (!lab) continue;
      // A correctly identified anchor triangle reproduces the canonical side
      // lengths almost exactly; 8% slack absorbs centroid quantisation and
      // mild perspective without admitting arbitrary blob triples.
      if (!(lab.err < 0.08)) continue;
      if (!(lab.scale > 0) || !Number.isFinite(lab.scale)) continue;
      // The rendered code cannot be larger than the image it lives in, and a
      // scale far below one pixel per node spacing cannot be sampled.
      const span = SPACE * lab.scale;
      if (span > 4 * Math.max(w, h)) continue;
      if (MIN_D * lab.scale < 3) continue;
      candidates.push(lab);
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => a.err - b.err);
    const shortlist = candidates.slice(0, MAX_CANDIDATES);

    const scored = [];
    for (const cand of shortlist) {
      const map = solveAffine(canon, cand.points);
      if (!map) continue;

      // The sampling radius is DERIVED from the recovered scale, not fixed in
      // pixels: nodeR_px = 0.36 * MIN_D * scale, and we sample a disc of
      // 0.35 * that. At px=1000 (scale 1) this is 3.02px inside a 6.05px white
      // interior; at px=800 (scale 0.8) it is 2.42px inside 4.84px. A fixed
      // 4px radius -- as sketched in the brief -- would straddle the ring edge
      // at px=800 and misclassify hollow nodes as solid.
      const nodeR = CANON_NODE_R * cand.scale;
      const sampleR = Math.max(0.5, SAMPLE_R_FACTOR * nodeR);
      const presenceR = PRESENCE_R_FACTOR * nodeR;

      const pts = new Array(L.nodes.length);
      let inside = 0;
      let present = 0;
      for (let i = 0; i < L.nodes.length; i++) {
        const p = map(L.nodes[i]);
        pts[i] = p;
        if (p.x >= 0 && p.y >= 0 && p.x < w && p.y < h) {
          inside++;
          if (markPresent(bin, w, h, p.x, p.y, presenceR)) present++;
        }
      }
      if (inside < L.nodes.length * 0.9) continue;
      const presence = present / L.nodes.length;
      if (presence < MIN_PRESENCE) continue;
      scored.push({ cand, pts, sampleR, presence });
    }
    if (scored.length === 0) return null;

    // Best geometric evidence first; ties broken by the side-length residual.
    scored.sort((a, b) => b.presence - a.presence || a.cand.err - b.cand.err);

    const bits = new Uint8Array(256);
    for (const s of scored.slice(0, MAX_RS_ATTEMPTS)) {
      for (let i = 0; i < 256; i++) {
        const p = s.pts[i];
        // Bit 1 is a filled disc (dark centre); bit 0 is a ring with a white
        // interior. Majority-dark inside the sample disc decides.
        bits[i] = darkFraction(bin, w, h, p.x, p.y, s.sampleR) > 0.5 ? 1 : 0;
      }
      const payload = bitsToPayload(bits);
      if (payload) return payload;
    }
    return null;
  } catch {
    return null;
  }
}

export default decode;
