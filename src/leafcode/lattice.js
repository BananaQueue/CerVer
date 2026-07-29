export const SPACE = 1000;
const SEED = 0x1eaf;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Leaf geometry in a centered space, then shifted into [0,SPACE].
const Lh = 820;   // leaf length
const Wmax = 250; // leaf max half-width
const CX = SPACE / 2;
const CY = SPACE / 2;

export function hw(u) {
  return (Wmax * Math.pow(Math.max(0, u), 0.45) * Math.pow(Math.max(0, 1 - u), 0.85)) / 0.45;
}
// u: 0 base -> 1 tip ; returns absolute canvas coords (tip toward top)
export function P(u, x) {
  return { x: CX + x, y: CY + (0.5 - u) * Lh };
}

// Fixed Poisson-disc minimum spacing. Chosen empirically: at SEED = 0x1eaf,
// minD=28 fails to place 256 nodes even after 400000 tries; minD=26 barely
// succeeds (34707 tries). minD=24 places all 256 nodes in only ~2524 tries,
// giving comfortable headroom under the default tries cap.
// MUST NOT CHANGE: the image decoder depends on identical geometry being
// reproduced from this exact constant.
const MIN_D = 24;
const TRIES_CAP = 200000;

export function lattice() {
  const rnd = mulberry32(SEED);
  const minD = MIN_D;
  const nodes = [];
  let tries = 0;
  while (nodes.length < 256 && tries < TRIES_CAP) {
    tries++;
    const u = 0.05 + rnd() * 0.9;
    const maxx = hw(u) * 0.9;
    const x = (rnd() * 2 - 1) * maxx;
    const p = P(u, x);
    let ok = true;
    for (const n of nodes) {
      const dx = n.x - p.x, dy = n.y - p.y;
      if (dx * dx + dy * dy < minD * minD) { ok = false; break; }
    }
    if (ok) nodes.push({ x: p.x, y: p.y, u });
  }
  if (nodes.length < 256) throw new Error(`lattice only placed ${nodes.length} nodes`);
  nodes.sort((a, b) => (a.u - b.u) || (a.x - b.x));
  const clean = nodes.map((n) => ({ x: n.x, y: n.y }));
  const anchors = [P(0.9, 0), P(0.3, -hw(0.3) * 0.6), P(0.09, 0)];
  return { nodes: clean, anchors, hw, P };
}
