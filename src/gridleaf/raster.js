import { SPACE, gridCells, P, outlineHalfWidth, STEM_LEN } from './mask.js';
import { COLS } from './codec.js';
import { strokeWidth } from './render.js';

// Pure-JS rasterizer: the same marks render.js draws, as RGBA pixels, so the
// decoder can be exercised headlessly (no browser, no camera).

export function rasterize(bits, { px = 600, cols = COLS, stem = true } = {}) {
  const { cell, cells } = gridCells(cols);
  const s = px / SPACE;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  const dark = (x, y) => {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= px || y >= px) return;
    const o = (y * px + x) * 4;
    data[o] = data[o + 1] = data[o + 2] = 0;
    data[o + 3] = 255;
  };
  const rect = (x0, y0, w, h) => {
    for (let y = Math.round(y0); y < Math.round(y0 + h); y++)
      for (let x = Math.round(x0); x < Math.round(x0 + w); x++) dark(x, y);
  };

  // data cells
  cells.forEach((cp, i) => {
    if (bits[i] !== 1) return;
    rect(cp.c * cell * s, cp.r * cell * s, (cell + 0.6) * s, (cell + 0.6) * s);
  });

  // Locator: a stroke one cell wide whose centre-line is offset OUTWARD by half
  // its width, so its inner edge just meets the leaf boundary and it never
  // covers an interior cell's centre.
  const sw = strokeWidth(cols);
  const half = (sw * s) / 2;
  const disc = (cx, cy) => {
    for (let dy = -half; dy <= half; dy++)
      for (let dx = -half; dx <= half; dx++) if (dx * dx + dy * dy <= half * half) dark(cx + dx, cy + dy);
  };
  const STEPS = 1200;
  for (let i = 0; i <= STEPS; i++) {
    const u = i / STEPS;
    const w = outlineHalfWidth(u, cols);
    disc(P(u, w).x * s, P(u, w).y * s);
    disc(P(u, -w).x * s, P(u, -w).y * s);
  }
  if (stem) {
    const base = P(0.012, 0);
    for (let t = 0; t <= STEM_LEN; t += 0.4) disc(base.x * s, (base.y + t) * s);
  }
  return { width: px, height: px, data };
}
