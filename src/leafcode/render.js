// LeafCode SVG renderer: the real, printable artwork.
//
// Geometry MUST mirror src/leafcode/raster.js exactly, or the printed code
// will not decode -- decode.js recovers scale from the anchor triangle and
// then samples node centres at radii derived from that scale, so any drift
// between the SVG's marks and the rasterizer's pixel geometry (radius
// factors, ring proportions, anchor size relative to nodes) is a silent
// decode failure, not a cosmetic difference.
//
// The constants below (MIN_D, NODE_R_FACTOR, ANCHOR_R_FACTOR,
// RING_WIDTH_FACTOR) are duplicated from raster.js on purpose: raster.js is
// frozen and does not export them, and lattice.js's MIN_D is not exported
// either. See raster.js and decode.js for the same duplication with the same
// justification.

import { lattice, SPACE, hw, P } from './lattice.js';

const MIN_D = 24;
const NODE_R_FACTOR = 0.36;
const ANCHOR_R_FACTOR = 1.8;
const RING_WIDTH_FACTOR = 0.3;

export function defaultRadii(px) {
  const s = px / SPACE;
  const nodeR = NODE_R_FACTOR * MIN_D * s;
  const anchorR = ANCHOR_R_FACTOR * nodeR;
  return { nodeR, anchorR };
}

// Upward-pointing equilateral-ish triangle points, matching raster.js's
// `triangle()` exactly (same 0.87/0.5 proportions).
function trianglePoints(cx, cy, r) {
  return [
    [cx, cy - r],
    [cx - r * 0.87, cy + r * 0.5],
    [cx + r * 0.87, cy + r * 0.5],
  ];
}

function fmt(v) {
  return (Math.round(v * 100) / 100).toString();
}

// --- Decoration --------------------------------------------------------
// Purely cosmetic: a leaf silhouette (traced from lattice.js's own hw/P
// helpers, so it always matches the actual node field), a central midrib,
// and a handful of secondary veins. Every decorative stroke is thin, light,
// low-opacity, and drawn BEFORE the marks; a white "clearance halo" is then
// drawn under every node/anchor mark before the mark itself, so no
// decoration can ever show through a mark (including the genuinely-white
// interior of a hollow bit-0 ring). This is belt-and-suspenders on top of
// already using light, low-opacity strokes: even if a vein's antialiased
// edge crept into a mark's footprint, the halo erases it first.
function leafOutlinePath(s, steps = 48) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const q = P(u, hw(u));
    pts.push([q.x * s, q.y * s]);
  }
  for (let i = steps; i >= 0; i--) {
    const u = i / steps;
    const q = P(u, -hw(u));
    pts.push([q.x * s, q.y * s]);
  }
  return 'M ' + pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' L ') + ' Z';
}

function decoration(s) {
  let out = '<g fill="none" stroke="#4a7a4a" stroke-opacity="0.22" stroke-linecap="round">';
  // Leaf silhouette.
  out += `<path d="${leafOutlinePath(s)}" stroke-width="${fmt(1.6 * s)}"/>`;
  // Midrib: base to tip along the centreline.
  const base = P(0.03, 0);
  const tip = P(0.98, 0);
  out += `<line x1="${fmt(base.x * s)}" y1="${fmt(base.y * s)}" x2="${fmt(tip.x * s)}" y2="${fmt(
    tip.y * s
  )}" stroke-width="${fmt(1.4 * s)}"/>`;
  // Secondary veins: a few per side, from the midrib out toward (but not
  // reaching) the leaf edge, so they never terminate on top of a mark.
  const veinUs = [0.18, 0.33, 0.48, 0.63, 0.78];
  for (const u of veinUs) {
    const w = hw(u) * 0.8;
    const c = P(u, 0);
    const r = P(u, w);
    const l = P(u, -w);
    out += `<line x1="${fmt(c.x * s)}" y1="${fmt(c.y * s)}" x2="${fmt(r.x * s)}" y2="${fmt(
      r.y * s
    )}" stroke-width="${fmt(1 * s)}"/>`;
    out += `<line x1="${fmt(c.x * s)}" y1="${fmt(c.y * s)}" x2="${fmt(l.x * s)}" y2="${fmt(
      l.y * s
    )}" stroke-width="${fmt(1 * s)}"/>`;
  }
  out += '</g>';
  return out;
}

export function renderSvg(bits, opts = {}) {
  const px = opts.px ?? SPACE;
  const decorate = opts.decorate ?? true;
  const s = px / SPACE;
  const { nodeR: defaultNodeR } = defaultRadii(px);
  const nodeR = opts.nodeR ?? defaultNodeR;
  const anchorR = opts.anchorR ?? ANCHOR_R_FACTOR * nodeR;
  const ringWidth = Math.max(1, nodeR * RING_WIDTH_FACTOR);

  const { nodes, anchors } = lattice();

  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}">`;
  out += `<rect x="0" y="0" width="${px}" height="${px}" fill="#ffffff"/>`;

  if (decorate) out += decoration(s);

  // Clearance halo: pure white, radius comfortably larger than the mark it
  // sits under, drawn immediately before that mark so any decoration
  // underneath is fully erased regardless of stroke width/opacity choices
  // above.
  const halo = (cx, cy, r) =>
    `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r * 1.3)}" fill="#ffffff"/>`;

  for (const a of anchors) {
    const cx = a.x * s;
    const cy = a.y * s;
    out += halo(cx, cy, anchorR);
    const pts = trianglePoints(cx, cy, anchorR);
    out += `<polygon points="${pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ')}" fill="#0a0a0a"/>`;
  }

  nodes.forEach((n, i) => {
    const cx = n.x * s;
    const cy = n.y * s;
    out += halo(cx, cy, nodeR);
    if (bits[i] === 1) {
      out += `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(nodeR)}" fill="#0a0a0a"/>`;
    } else {
      // Ring: outer edge at nodeR, inner (white) edge at nodeR - ringWidth,
      // exactly matching raster.js's ring(cx, cy, nodeR, ringWidth). An SVG
      // stroke straddles the path radius, so the stroked circle's own
      // radius must sit at the annulus midpoint (nodeR - ringWidth / 2) for
      // its outer/inner edges to land on nodeR and nodeR - ringWidth.
      const strokeR = nodeR - ringWidth / 2;
      out += `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(strokeR)}" fill="#ffffff" stroke="#0a0a0a" stroke-width="${fmt(
        ringWidth
      )}"/>`;
    }
  });

  out += '</svg>';
  return out;
}

export default renderSvg;
