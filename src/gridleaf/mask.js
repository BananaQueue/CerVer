// GridLeaf geometry: a broad leaf silhouette carrying a grid of square cells.
//
// Unlike the earlier dot-based LeafCode, cells here TILE EDGE-TO-EDGE like a
// Data Matrix. Adjacent dark cells merging is expected and harmless, which is
// what lets the mark shrink: the decoder never needs gaps between marks, and
// never needs to resolve detail *inside* a cell — only "is this cell dark".
//
// Two geometry rules earn their keep:
//   1. The locator stroke is drawn ENTIRELY OUTSIDE the leaf boundary. Centred
//      on the boundary it would cover the outermost cells' centres, making those
//      bits permanently unreadable.
//   2. The leaf plus its stroke and stem must fit inside the canonical box with
//      margin. Overflowing it means the decoder finds a CLIPPED tip at the image
//      edge instead of the real one, and the projective fit is garbage.

export const SPACE = 1000;
export const STEM_LEN = 190; // canonical units the stem extends past the base

const LH = 620; // leaf length
const WMAX = 360; // leaf max half-width
const CX = SPACE / 2;
// Leaf sits HIGH in the box so a long stem can hang below it. The stem costs
// no grid cells (it is outside the leaf) but makes the tip unambiguously the
// farthest point from the mark centroid, which is how orientation is found.
const CY = 380;

/** Locator stroke width in canonical units — one cell, so it blurs like data. */
export function strokeW(cols) {
  return SPACE / cols;
}

/** Leaf half-width at u (0 = base, 1 = tip). Broad body, rounded base, clear tip. */
export function hw(u) {
  if (u <= 0 || u >= 1) return 0;
  return WMAX * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.62)), 0.78);
}

export function P(u, x) {
  return { x: CX + x, y: CY + (0.5 - u) * LH };
}

export function uOf(y) {
  return 0.5 - (y - CY) / LH;
}

export function insideLeaf(x, y) {
  const u = uOf(y);
  if (u <= 0.012 || u >= 0.995) return false;
  return Math.abs(x - CX) <= hw(u);
}

/**
 * Usable cells of a cols x cols grid, in a stable order (row-major). A cell is
 * usable when its CENTRE lies inside the leaf — the decoder samples centres, and
 * the locator stroke is kept outside the boundary, so a boundary cell's centre
 * is never occluded.
 */
export function gridCells(cols) {
  const cell = SPACE / cols;
  const cells = [];
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cell;
      const y = (r + 0.5) * cell;
      if (insideLeaf(x, y)) cells.push({ r, c, x, y });
    }
  }
  return { cols, cell, cells };
}

export function fillFraction(cols) {
  return gridCells(cols).cells.length / (cols * cols);
}

/** Centre-line of the locator stroke: offset outward so it clears the cells. */
export function outlineHalfWidth(u, cols) {
  return hw(u) + strokeW(cols) / 2;
}

function widest() {
  let bestU = 0.5;
  let bestW = -1;
  for (let i = 1; i < 1000; i++) {
    const u = i / 1000;
    const w = hw(u);
    if (w > bestW) {
      bestW = w;
      bestU = u;
    }
  }
  return { bestU, bestW };
}

/**
 * Reference points as the decoder actually sees them: the extreme pixels of the
 * mark, which lie a full stroke width outside the leaf boundary (the stroke is
 * offset outward by half its width, then extends another half).
 */
export function refPoints(cols) {
  const sw = strokeW(cols);
  const { bestU, bestW } = widest();
  const tipP = P(0.995, 0);
  const baseP = P(0.012, 0);
  return {
    tip: { x: tipP.x, y: tipP.y - sw },
    stemEnd: { x: baseP.x, y: baseP.y + STEM_LEN + sw / 2 },
    left: { x: CX - bestW - sw, y: P(bestU, 0).y },
    right: { x: CX + bestW + sw, y: P(bestU, 0).y },
    widestU: bestU,
  };
}

/** Assert the whole mark fits the canonical box; used by tests. */
export function extent(cols) {
  const sw = strokeW(cols);
  const { bestW } = widest();
  return {
    top: P(0.995, 0).y - sw,
    bottom: P(0.012, 0).y + STEM_LEN + sw,
    left: CX - bestW - sw,
    right: CX + bestW + sw,
  };
}
