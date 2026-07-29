// LeafCode pure-JS rasterizer (test double). Draws the 256 encoded bits as
// dots on the 256-node leaf lattice (solid = bit 1, hollow ring = bit 0)
// plus 3 filled triangular anchors, into an RGBA pixel buffer. No canvas
// library, no browser, no camera: this exists so the next task's image
// decoder (and the Gate A round-trip test) can run headlessly.
//
// Geometry note: lattice.js fixes SPACE=1000 with a minimum node-to-node
// spacing (MIN_D) of 24 canonical units, and a 40-unit clearance around each
// anchor. Radii here are DERIVED from that spacing and the requested canvas
// size, not hard-coded pixels -- a fixed-pixel radius that looks fine at one
// canvas size will make neighbouring dots merge (or shrink to nothing) at
// another. See task-5-report.md for the numbers this produces at px=1000
// and px=800.

import { lattice, SPACE } from './lattice.js';

// Must mirror lattice.js's MIN_D. Not imported because lattice.js does not
// export it (and must not be modified by this task); duplicated here as a
// documented constant instead of a magic number.
const MIN_D = 24;

// Default node radius as a fraction of MIN_D canonical units. 0.36 leaves a
// comfortable gap between the closest possible neighbouring node pair
// (centre distance MIN_D) at any canvas scale: 2 * 0.36 = 0.72 < 1.
const NODE_R_FACTOR = 0.36;

// Anchors get a clearance of 40 canonical units (vs. MIN_D=24 for ordinary
// nodes) specifically so they can be drawn larger and still not touch a
// neighbouring data dot. This must keep anchors the largest marks on the
// image by PIXEL AREA, not just by radius -- a blob detector (the expected
// decoding strategy) measures connected-component size, and an equilateral
// triangle has a smaller area than a circle of the same circumradius
// (area ratio ~0.417). A factor of 1.4 (the task brief's suggested
// starting point) only gets triangle-area to ~0.82x of the disc's area,
// i.e. anchors would render as SMALLER blobs than solid data nodes despite
// having a larger radius -- verified by this file's own area-based test.
// 1.8x pushes triangle area to ~1.35x of a solid disc's area, a comfortable
// margin either way a decoder might measure "largest".
const ANCHOR_R_FACTOR = 1.8;

// Ring (hollow, bit-0) stroke width as a fraction of the node radius. At
// 0.3, the white interior left behind has radius 0.7 * nodeR, which fully
// covers the "middle third" band of the radius (nodeR/3 .. 2*nodeR/3) with
// margin to spare -- see task-5-report.md for the measured white radius.
const RING_WIDTH_FACTOR = 0.3;

// Compute the default node/anchor radii for a given canvas size. Exported
// (in addition to `rasterize`) so tests can verify the exact geometry
// without duplicating the formula.
export function defaultRadii(px) {
  const s = px / SPACE;
  const nodeR = NODE_R_FACTOR * MIN_D * s;
  const anchorR = ANCHOR_R_FACTOR * nodeR;
  return { nodeR, anchorR };
}

export function rasterize(bits, opts = {}) {
  const px = opts.px ?? SPACE; // 1 canonical unit = 1 px by default
  const s = px / SPACE;
  const defaults = defaultRadii(px);
  const nodeR = opts.nodeR ?? defaults.nodeR;
  // Anchor radius derives from the *actual* nodeR in use (default or
  // override) so anchors stay the largest marks even if a caller overrides
  // nodeR alone.
  const anchorR = opts.anchorR ?? ANCHOR_R_FACTOR * nodeR;
  const ringWidth = Math.max(1, nodeR * RING_WIDTH_FACTOR);

  const { nodes, anchors } = lattice();
  const data = new Uint8ClampedArray(px * px * 4).fill(255);

  const setDark = (x, y) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= px || y >= px) return;
    const o = (y * px + x) * 4;
    data[o] = data[o + 1] = data[o + 2] = 0;
    data[o + 3] = 255;
  };

  // Filled disc: every pixel within r of (cx, cy) goes dark. Used for
  // bit-1 nodes (dark right at the centre) and as the anchor fill shape's
  // building block is a separate triangle rasterizer below.
  const disc = (cx, cy, r) => {
    const ri = Math.ceil(r);
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        if (dx * dx + dy * dy <= r * r) setDark(cx + dx, cy + dy);
      }
    }
  };

  // Hollow ring: an annulus from (outerR - width) to outerR goes dark; the
  // interior disc of radius (outerR - width) is left untouched (white
  // background), which is what the decoder samples to classify a bit 0.
  const ring = (cx, cy, outerR, width) => {
    const innerR = outerR - width;
    const ri = Math.ceil(outerR);
    const innerR2 = innerR * innerR;
    const outerR2 = outerR * outerR;
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 <= outerR2 && d2 >= innerR2) setDark(cx + dx, cy + dy);
      }
    }
  };

  // Filled upward-pointing triangle for anchors, via barycentric sign test.
  const triangle = (cx, cy, r) => {
    const a = [cx, cy - r];
    const b = [cx - r * 0.87, cy + r * 0.5];
    const c = [cx + r * 0.87, cy + r * 0.5];
    const sign = (p, q, o) => (q[0] - p[0]) * (o[1] - p[1]) - (q[1] - p[1]) * (o[0] - p[0]);
    const minX = Math.floor(cx - r);
    const maxX = Math.ceil(cx + r);
    const minY = Math.floor(cy - r);
    const maxY = Math.ceil(cy + r);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const d1 = sign(a, b, [x, y]);
        const d2 = sign(b, c, [x, y]);
        const d3 = sign(c, a, [x, y]);
        const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
        const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
        if (!(hasNeg && hasPos)) setDark(x, y);
      }
    }
  };

  for (const a of anchors) triangle(a.x * s, a.y * s, anchorR);
  nodes.forEach((n, i) => {
    const cx = n.x * s;
    const cy = n.y * s;
    if (bits[i] === 1) disc(cx, cy, nodeR);
    else ring(cx, cy, nodeR, ringWidth);
  });

  return { width: px, height: px, data };
}
