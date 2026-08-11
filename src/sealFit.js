import { sealBlock } from './sealer.js';

// Does the seal land on top of something?
//
// The seal is stamped at a fixed spot in the lower-right corner. That corner is
// usually footer whitespace, but "usually" is not good enough: a document laid
// out differently can carry a signature, an initial, a page number or a control
// number exactly there, and stamping over it would obscure the very content the
// seal is supposed to vouch for. Worse, it would be silent — the sealed PDF
// looks fine until someone reads the paper.
//
// So the page is inspected BEFORE sealing and anything already occupying the
// seal's rectangle is reported: text, images, and drawn graphics alike.
//
// This reads the page's own drawing instructions rather than rendering it, so it
// needs no browser and is exact about position. What it cannot judge is
// importance — a footer rule crossing the corner is a hit, and so is a
// signature; deciding which matters is left to the person sealing.

const EPS = 0.01; // ignore hairline touches at the very edge

// A stand-in footer for measuring the block before the real seal exists. Same
// shape as the printed line, so the width is right to within a character.
export const SAMPLE_FOOTER = 'EMB · R1-2026-000000 · p1/1 · K1 · AAAA-AAAA';

/** Do two rectangles share any area? */
function overlaps(a, b) {
  return a.x0 < b.x1 - EPS && a.x1 > b.x0 + EPS && a.y0 < b.y1 - EPS && a.y1 > b.y0 + EPS;
}

/** Apply a PDF transformation matrix [a,b,c,d,e,f] to a point. */
function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Multiply two PDF transformation matrices. */
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Bounding box of the unit square under a matrix — where an image lands. */
function unitSquareBox(m) {
  const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Every drawn text item on the page, boxed, from pdf.js text positions. */
function textBoxes(textContent) {
  const hits = [];
  for (const it of textContent.items) {
    if (!it.str || !it.str.trim()) continue;
    const [x, y] = [it.transform[4], it.transform[5]];
    // pdf.js reports width/height in the text's own space; height is the font
    // size, and the origin sits on the BASELINE, so the box runs a little below.
    const h = it.height || Math.abs(it.transform[3]) || 0;
    const box = { x0: x, x1: x + (it.width || 0), y0: y - h * 0.25, y1: y + h * 0.85 };
    hits.push({ kind: 'text', text: it.str.trim(), box });
  }
  return hits;
}

/**
 * Every image and drawn path on the page, boxed.
 *
 * Walks the page's operator list carrying the current transformation matrix, so
 * a placed image or a stroked path is measured where it actually lands rather
 * than in its own coordinates.
 */
async function graphicBoxes(pdfjs, page) {
  const { OPS } = pdfjs;
  const list = await page.getOperatorList();
  const hits = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];

  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];

    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject ||
             fn === OPS.paintImageMaskXObject) {
      hits.push({ kind: 'image', box: unitSquareBox(ctm) });
    } else if (fn === OPS.constructPath) {
      // args = [paintOp, coords, minMax]. The first entry says what happens to
      // the path once built. `endPath` means it is thrown away — it was only
      // there to set a clipping region, and clipping draws nothing. A real EMB
      // order carries 230 such full-page paths, every one of which "overlapped"
      // the seal and buried the one finding that mattered.
      if (args[0] === OPS.endPath) continue;

      // pdf.js has already reduced the path to a bounding box in
      // minMax = [minX, minY, maxX, maxY]; the coords entry is an array of typed
      // arrays, one per subpath, so it is not a flat list.
      const mm = args[2];
      let box = null;
      if (mm && mm.length >= 4) {
        const [a, b] = [apply(ctm, mm[0], mm[1]), apply(ctm, mm[2], mm[3])];
        box = {
          x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]),
          y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]),
        };
      } else {
        const subpaths = Array.isArray(args[1]) ? args[1] : [args[1]];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const sp of subpaths) {
          if (!sp) continue;
          for (let j = 0; j + 1 < sp.length; j += 2) {
            const [px, py] = apply(ctm, sp[j], sp[j + 1]);
            if (px < x0) x0 = px;
            if (px > x1) x1 = px;
            if (py < y0) y0 = py;
            if (py > y1) y1 = py;
          }
        }
        if (x1 >= x0) box = { x0, y0, x1, y1 };
      }
      if (box) {
        // A perfectly horizontal or vertical rule has zero area; give it a
        // hairline thickness so a line crossing the corner still counts.
        const thickness = Math.min(box.x1 - box.x0, box.y1 - box.y0);
        if (box.x1 === box.x0) box.x1 = box.x0 + 0.5;
        if (box.y1 === box.y0) box.y1 = box.y0 + 0.5;
        // A rule is a line; a signature or a stamp is a shape. Both are drawn
        // the same way, so they are told apart by how thin they are — otherwise
        // every document with a footer rule reports a problem and the warning
        // stops meaning anything.
        hits.push({ kind: 'graphic', box, rule: thickness < 2 });
      }
    }
  }
  return hits;
}

/** Everything drawn on every page, boxed once so many rectangles can be tested. */
async function collect(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = Uint8Array.from(bytes); // copy — pdfjs may detach the buffer
  // The standard fonts are not embedded in these PDFs; without them pdf.js warns
  // on every page and cannot size the text it is asked to measure.
  const standardFontDataUrl = new URL(
    '../node_modules/pdfjs-dist/standard_fonts/',
    import.meta.url
  ).href;
  const pdf = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    standardFontDataUrl,
  }).promise;

  const out = [];
  for (let k = 1; k <= pdf.numPages; k++) {
    const page = await pdf.getPage(k);
    const [, , width, height] = page.view; // [x0, y0, x1, y1] in points
    out.push({
      k,
      width,
      height,
      boxes: [...textBoxes(await page.getTextContent()), ...(await graphicBoxes(pdfjs, page))],
    });
  }
  await pdf.cleanup();
  return out;
}

/**
 * Check every page of a PDF for content under the seal.
 *
 * @returns {Promise<{ clear: boolean, seal: object, pages: Array }>}
 */
export async function checkSealFit(bytes, { mm, footer = SAMPLE_FOOTER, at } = {}) {
  const collected = await collect(bytes);

  const pages = [];
  for (const { k, width, height, boxes } of collected) {
    const seal = sealBlock(width, { ...(mm ? { mm } : {}), footer, at }).block;
    const hits = boxes.filter((b) => overlaps(b.box, seal));

    // Content the seal would obscure, as against decoration it would merely
    // cross. Only the first is worth stopping for.
    const covering = hits.filter((h) => h.kind !== 'graphic' || !h.rule);
    const rules = hits.filter((h) => h.kind === 'graphic' && h.rule);

    pages.push({
      k,
      width,
      height,
      clear: covering.length === 0,
      hits,
      // The distinct pieces of text that would be covered, for the report.
      covered: [...new Set(hits.filter((h) => h.kind === 'text').map((h) => h.text))],
      images: hits.filter((h) => h.kind === 'image').length,
      shapes: hits.filter((h) => h.kind === 'graphic' && !h.rule).length,
      rules: rules.length,
    });
  }

  const first = pages[0];
  return {
    clear: pages.every((p) => p.clear),
    // Pages where the seal only crosses a rule — worth mentioning, not stopping.
    ruled: pages.filter((p) => p.clear && p.rules > 0).map((p) => p.k),
    seal: first ? sealBlock(first.width, { ...(mm ? { mm } : {}), footer, at }).block : null,
    pages,
  };
}

/**
 * Find somewhere the seal fits on EVERY page without covering anything.
 *
 * The default corner is not always available: a real EMB Special Order carries
 * its own QR exactly there, and the whole footer band is taken by the ISO mark,
 * the address block and that QR. Rather than make someone measure a new spot by
 * hand for each layout, the page is searched.
 *
 * The search keeps the conventional placement wherever it can: candidates are
 * ranked by distance from the usual bottom-right corner, so the seal moves as
 * little as the page allows and staff still know where to look.
 *
 * @returns {Promise<{ found: boolean, spot: object|null, tried: number }>}
 */
export async function findClearSpot(
  bytes,
  { mm, footer = SAMPLE_FOOTER, step = 6, edge = 20, quiet = 12 } = {}
) {
  const collected = await collect(bytes);
  if (!collected.length) return { found: false, spot: null, tried: 0 };

  const { width, height } = collected[0];
  const homeBlock = sealBlock(width, { ...(mm ? { mm } : {}), footer });
  const home = homeBlock.block;
  const w = home.x1 - home.x0;
  const h = home.y1 - home.y0;
  // Offsets of the mark within the block, so a candidate position can be turned
  // back into the two rectangles that have different requirements.
  const markDx = homeBlock.mark.x0 - home.x0;
  const markDy = homeBlock.mark.y0 - home.y0;
  const markW = homeBlock.mark.x1 - homeBlock.mark.x0;
  const markH = homeBlock.mark.y1 - homeBlock.mark.y0;
  const footDy = homeBlock.footer.y1 - home.y0;

  // Only content blocks a position; a hairline rule may be crossed, exactly as
  // in the check itself.
  const blocking = collected.map((p) => p.boxes.filter((b) => b.kind !== 'graphic' || !b.rule));

  let best = null;
  let tried = 0;
  for (let y0 = edge; y0 + h <= height - edge; y0 += step) {
    for (let x0 = edge; x0 + w <= width - edge; x0 += step) {
      const rect = { x0, y0, x1: x0 + w, y1: y0 + h };
      // The mark and the line beneath it need different things.
      //
      // The mark must not merely avoid overlapping — it needs room. The first
      // spot this found on a real EMB order sat 2 pt from the document's own QR
      // and just under a line of text. Nothing overlapped, and it was still
      // useless: the decoder treats dark shapes near the mark as part of it, so
      // the neighbours were dragged into its bounding box and the scale came out
      // wrong. A machine-readable mark needs a quiet zone, like any barcode.
      //
      // The line is only text. It has to sit on blank paper, but nothing is
      // reading it optically, so it needs no margin — and demanding one for the
      // whole 158 pt block left a full A4 order with nowhere to put the seal.
      const room = {
        x0: x0 + markDx - quiet, y0: y0 + markDy - quiet,
        x1: x0 + markDx + markW + quiet, y1: y0 + markDy + markH + quiet,
      };
      const line = { x0, y0, x1: x0 + w, y1: y0 + footDy };
      tried++;
      if (blocking.some((boxes) => boxes.some((b) => overlaps(b.box, room) || overlaps(b.box, line))))
        continue;
      // Distance from where the seal would normally sit.
      const d = Math.hypot(x0 - home.x0, y0 - home.y0);
      if (!best || d < best.d) best = { d, rect };
    }
  }

  return {
    found: !!best,
    spot: best ? { ...best.rect, movedBy: Math.round(best.d) } : null,
    home,
    tried,
  };
}
