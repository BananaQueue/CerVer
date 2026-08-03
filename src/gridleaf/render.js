import { SPACE, gridCells, hw, P, strokeW as maskStrokeW, outlineHalfWidth, STEM_LEN, dataCells, frondCells } from './mask.js';
import { COLS } from './codec.js';

// Draw a GridLeaf. Cells tile edge-to-edge; the leaf outline is the locator and
// is drawn SOLID and dark, exactly like a Data Matrix's L-bar — it must be
// unmistakable and must never be confused with data.

function outlinePath(cols, steps = 160) {
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const p = P(u, outlineHalfWidth(u, cols));
    d += (i ? 'L' : 'M') + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ' ';
  }
  for (let i = steps; i >= 0; i--) {
    const u = i / steps;
    const p = P(u, -outlineHalfWidth(u, cols));
    d += 'L' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ' ';
  }
  return d + 'Z';
}

export function strokeWidth(cols = COLS) {
  return maskStrokeW(cols);
}

/**
 * @param {Uint8Array} bits length >= usable cells
 * @returns {string} standalone SVG
 */
export function renderSvg(bits, { px = 600, cols = COLS, stem = true } = {}) {
  const { cell } = gridCells(cols);
  const cells = dataCells(cols);
  const motif = frondCells(cols);
  const s = px / SPACE;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}">`;
  out += `<rect width="${px}" height="${px}" fill="#fff"/>`;
  // Cells: +0.5 canonical overlap so neighbours abut with no hairline seam.
  const box = (cp) => {
    const x = (cp.c * cell * s).toFixed(2);
    const y = (cp.r * cell * s).toFixed(2);
    const w = ((cell + 0.6) * s).toFixed(2);
    return `<rect x="${x}" y="${y}" width="${w}" height="${w}" fill="#000"/>`;
  };
  // Fixed motif first (frond), then the payload cells.
  motif.forEach((cp) => {
    out += box(cp);
  });
  cells.forEach((cp, i) => {
    if (bits[i] === 1) out += box(cp);
  });
  out += `<path d="${outlinePath(cols)}" fill="none" stroke="#000" stroke-width="${(strokeWidth(cols) * s).toFixed(2)}" stroke-linejoin="round" transform="scale(${s})"/>`;
  if (stem) {
    const base = P(0.012, 0);
    out += `<line x1="${(base.x * s).toFixed(1)}" y1="${(base.y * s).toFixed(1)}" x2="${(base.x * s).toFixed(1)}" y2="${((base.y + STEM_LEN) * s).toFixed(1)}" stroke="#000" stroke-width="${(strokeWidth(cols) * s).toFixed(2)}" stroke-linecap="round"/>`;
  }
  return out + '</svg>';
}
