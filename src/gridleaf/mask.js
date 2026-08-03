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

// ---------------------------------------------------------------------------
// DENR/EMB seal motif.
//
// The seal is not just a disc: it carries a frond (a vertical midrib with
// diagonal veins) over stepped horizontal bands. Those features are reproduced
// here as FIXED cells rather than decoration, which earns three things at once:
// the mark reads as the institutional seal, the frond's asymmetry gives the
// decoder an orientation reference far stronger than a tab, and the banding
// gives the lower half the seal's rhythm.
//
// Fixed cells carry no payload, so they cost capacity — the grid is sized to
// leave enough data cells over.

const FROND_TOP = 0.10; // fraction of the disc height where the frond starts
const FROND_BOT = 0.52; // ...and ends (the bands take over below)

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const L = vx * vx + vy * vy;
  let t = L ? (wx * vx + wy * vy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Is this canonical point part of the frond motif (midrib + veins)? */
export function inFrond(x, y, cols) {
  const t = strokeW(cols) * 0.55; // motif line thickness
  const top = CY - R + 2 * R * FROND_TOP;
  const bot = CY - R + 2 * R * FROND_BOT;
  // midrib
  if (segDist(x, y, CX, top, CX, bot) <= t) return true;
  // veins: pairs branching up-and-out from the midrib
  const N = 5;
  for (let i = 0; i < N; i++) {
    const yy = top + ((i + 0.7) / N) * (bot - top);
    const len = 0.30 * R * (1 - 0.10 * i);
    for (const s of [-1, 1]) {
      if (segDist(x, y, CX, yy, CX + s * len, yy - len * 0.75) <= t) return true;
    }
  }
  return false;
}

/** Stepped white gaps that give the lower half the seal's banding. */
export function inBandGap(x, y, cols) {
  const bandTop = CY - R + 2 * R * FROND_BOT;
  if (y < bandTop) return false;
  const cell = SPACE / cols;
  const step = cell * (x > CX ? 1 : 0); // the seal's bands are stepped, not straight
  const rel = y - bandTop + step;
  const period = cell * 3;
  return rel % period < cell * 0.9;
}

/**
 * Cells that carry payload.
 *
 * Excluded: the motif itself, the band gaps, and a one-cell KEEP-OUT margin
 * around the motif. Without that margin the frond is surrounded by random data
 * cells and simply disappears into the noise — a fixed motif is only legible if
 * it has clear space around it.
 */
export function dataCells(cols) {
  const cell = SPACE / cols;
  const keepOut = (c) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (inFrond(c.x + dx * cell, c.y + dy * cell, cols)) return true;
      }
    }
    return false;
  };
  return gridCells(cols).cells.filter((c) => !keepOut(c) && !inBandGap(c.x, c.y, cols));
}

/** Cells drawn dark as fixed motif (frond). */
export function frondCells(cols) {
  return gridCells(cols).cells.filter((c) => inFrond(c.x, c.y, cols));
}
