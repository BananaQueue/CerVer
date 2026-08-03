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
export const STEM_LEN = 120; // canonical units the tab extends past the disc

// Shape: the DENR/EMB seal's outer form — a DISC, not a leaf.
//
// This is a large functional win, not only a branding one. A disc fills ~79% of
// its own bounding square where the leaf silhouette managed ~31%, so the same
// payload needs far fewer cells across, which is what actually shrinks the mark.
//
// A disc has no orientation of its own, so a short solid TAB hangs below it —
// the same trick the stem played, and the tab is what the decoder anchors on
// (it is the farthest point of the mark from the centroid by construction).
const R = 360; // disc radius
const CX = SPACE / 2;
const CY = 440;

/** Locator stroke width in canonical units — one cell, so it blurs like data. */
export function strokeW(cols) {
  return SPACE / cols;
}

// Disc parametrised by u: u=0 is the bottom (where the tab attaches), u=1 the
// top, u=0.5 the widest. Keeping the same (u, half-width) form as the earlier
// leaf means the outline-offset, reference-point and sampling code all carry
// over unchanged.
export function hw(u) {
  if (u <= 0 || u >= 1) return 0;
  return R * Math.sin(Math.PI * u);
}

export function P(u, x) {
  return { x: CX + x, y: CY + R * Math.cos(Math.PI * u) };
}

export function uOf(y) {
  const c = Math.min(1, Math.max(-1, (y - CY) / R));
  return Math.acos(c) / Math.PI;
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

/** Disc centre and radius in canonical units (the decoder fits a similarity). */
export function disc(cols) {
  return { cx: CX, cy: CY, r: R, rOuter: R + strokeW(cols) };
}
