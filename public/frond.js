// Deterministic "living frond" — a small botanical emblem grown from a page's
// seal. Same module is used by the PDF sealer (server) and the verify UI (client)
// so the printed frond and the on-screen frond are identical for comparison.

function xfnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns path strings in a 0..100 box plus the fixed EMB colors (0..1 channels).
export function frondSvg(seed) {
  const r = mulberry32(xfnv1a(String(seed)));
  const P = (x, y) => `${(50 + x).toFixed(1)},${(50 + y).toFixed(1)}`;
  const pairs = 5 + Math.floor(r() * 4);

  const stem = `M ${P(0, 32)} C ${P(r() * 6 - 3, 10)} ${P(r() * 6 - 3, -8)} ${P(0, -34)}`;

  let leaves = '';
  for (let i = 0; i < pairs; i++) {
    const t = i / (pairs - 1);
    const y = 32 - t * 66;
    const len = 6 + (1 - Math.abs(t - 0.45)) * 16 + r() * 3;
    const ang = ((28 + r() * 22) * Math.PI) / 180;
    for (const s of [-1, 1]) {
      const x2 = s * len * Math.cos(ang);
      const y2 = y - len * Math.sin(ang);
      leaves += `M ${P(0, y)} Q ${P(s * len * 0.5, y - 2)} ${P(x2, y2)} `;
    }
  }

  const dr = 2.4;
  const dot = `M ${50 - dr},16 a ${dr},${dr} 0 1,0 ${2 * dr},0 a ${dr},${dr} 0 1,0 ${-2 * dr},0 Z`;

  return {
    size: 100,
    stem,
    leaves,
    dot,
    colors: {
      ink: { r: 0.043, g: 0.239, b: 0.18 },
      leaf: { r: 0.105, g: 0.478, b: 0.302 },
      gold: { r: 0.54, g: 0.48, b: 0.18 },
    },
  };
}

// Convenience for the browser: an <svg> string at the given pixel size.
export function frondSvgMarkup(seed, px = 72) {
  const f = frondSvg(seed);
  const c = (o) => `rgb(${Math.round(o.r * 255)},${Math.round(o.g * 255)},${Math.round(o.b * 255)})`;
  return `<svg viewBox="0 0 100 100" width="${px}" height="${px}" aria-hidden="true">
    <path d="${f.stem}" fill="none" stroke="${c(f.colors.ink)}" stroke-width="1.4" stroke-linecap="round"/>
    <path d="${f.leaves}" fill="none" stroke="${c(f.colors.leaf)}" stroke-width="1.2" stroke-linecap="round"/>
    <path d="${f.dot}" fill="${c(f.colors.gold)}"/>
  </svg>`;
}
