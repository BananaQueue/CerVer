import { PDFDocument, StandardFonts, PDFName, rgb, degrees } from 'pdf-lib';
import { extractPageTexts } from './pdfTools.js';
import { canonicalize, digestPage, computeSeal, formatFooter, payloadFor } from './sealCode.js';

const INK = rgb(0.043, 0.239, 0.18); // EMB pine green

// The EMB seal code: the DENR/EMB logo pixelated to a 44x44 tile grid, with the
// payload carried by clearing interior tiles. Drawn as vector rectangles rather
// than an embedded raster so it stays crisp at any print resolution.
//
// 16 mm — 0.36 mm per tile.
//
// The earlier 22 mm came from photographing a printed calibration ladder: 18 mm
// read only sometimes, 22 mm read first time, and the conclusion drawn was that
// ink spread left almost no headroom below 22 mm. That conclusion was wrong, and
// the ladder was not what was wrong with it.
//
// The scanner was decoding a different region of the camera frame than the
// preview displayed, so part of the mark was routinely cropped out of the image
// being read. Small marks failed first, because they had least margin for a crop
// that nobody could see. The ladder faithfully measured a capture bug and
// reported it as a property of the ink.
//
// With the capture region corrected to match the viewport, 14 mm reads. 16 mm is
// that result with a rung of margin kept back, rather than the smallest size
// observed to work.
//
// Note what is still untested: the ladder was never rephotographed after the
// capture fix. This is one size confirmed by hand, not a re-measured curve, and
// the ink-spread limit that 22 mm was blamed on has not been located — only
// shown to sit below 14 mm. Reprint the ladder before trusting anything smaller.
export const SEALCODE_MM = 16;
const SEAL_MARGIN = 26; // pt in from the right edge
const SEAL_BASELINE = 34; // pt up from the bottom edge
const FOOTER_SIZE = 6; // pt, Courier
const FOOTER_GAP = 8; // pt between the mark and the line under it

// Courier is monospace: every glyph advances 0.6 em.
const footerWidthOf = (text) => text.length * FOOTER_SIZE * 0.6;

/**
 * Where the seal lands on a page of this width, in PDF points with the origin
 * at the bottom-left. Exported so the overlap check measures the same rectangle
 * the sealer stamps rather than a second copy of these numbers.
 */
export function sealRect(pageWidth, { mm = SEALCODE_MM, margin = SEAL_MARGIN } = {}) {
  const size = (mm / 25.4) * 72; // mm -> points
  return {
    x0: pageWidth - margin - size,
    y0: SEAL_BASELINE,
    x1: pageWidth - margin,
    y1: SEAL_BASELINE + size,
    size,
  };
}

/**
 * The mark AND the human-readable line beneath it, as one block.
 *
 * They have to move together. The line is the fallback when nothing will scan,
 * so it is no use having the mark clear of the page's own content while the line
 * lands on top of a control number — which is exactly what happens on a real EMB
 * order, where the footer band is already full.
 *
 * `at` overrides the block's bottom-left corner when the usual place is taken.
 */
export function sealBlock(pageWidth, { mm = SEALCODE_MM, margin = SEAL_MARGIN, footer = '', at } = {}) {
  const size = (mm / 25.4) * 72;
  const fw = Math.max(footerWidthOf(footer), size);
  const blockW = Math.max(size, fw);
  // The line is right-aligned with the mark, so the block grows leftwards.
  const x1 = at ? at.x0 + blockW : pageWidth - margin;
  const y0 = at ? at.y0 : SEAL_BASELINE - FOOTER_GAP - FOOTER_SIZE;
  const markY0 = y0 + FOOTER_GAP + FOOTER_SIZE;
  return {
    block: { x0: x1 - blockW, y0, x1, y1: markY0 + size },
    mark: { x0: x1 - size, y0: markY0, x1, y1: markY0 + size, size },
    footer: { x0: x1 - fw, y0, x1, y1: y0 + FOOTER_SIZE, size: FOOTER_SIZE },
  };
}

async function drawSealCode(pg, payload, rect) {
  const { tilesFor, SIZE } = await import('./sealcode/encode.js');
  const tiles = tilesFor(payload);
  const { x0, y0, size } = rect;
  const t = size / SIZE;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!tiles[r][c]) continue;
      pg.drawRectangle({
        x: x0 + c * t,
        // PDF y grows upward; tile row 0 is the top of the mark.
        y: y0 + (SIZE - 1 - r) * t,
        width: t + 0.12, // hairline overlap so neighbours abut cleanly
        height: t + 0.12,
        color: rgb(0.05, 0.05, 0.05),
      });
    }
  }
}

// Light hardening: bake in interactivity, drop document-level scripts/actions,
// and stamp sealed metadata. Keeps the text layer intact (so the Full-check
// re-hash still works). This is deterrence — tamper-EVIDENCE comes from the
// seals, not from making the file uneditable.
function hardenPdf(pdf, iisNo) {
  try {
    pdf.getForm().flatten(); // bake any AcroForm fields into static content
  } catch {
    // no form / unflattenable — fine
  }
  try {
    pdf.catalog.delete(PDFName.of('OpenAction')); // no auto-run action
  } catch {
    /* ignore */
  }
  try {
    const names = pdf.catalog.lookupMaybe?.(PDFName.of('Names'));
    if (names && names.delete) names.delete(PDFName.of('JavaScript')); // strip doc JS
  } catch {
    /* ignore */
  }
  // Title/Subject/Keywords are preserved by pdf-lib's save (Producer/dates are
  // not — pdf-lib stamps its own), so the sealed marker lives in these.
  pdf.setTitle(`Sealed document ${iisNo} — CerVer`);
  pdf.setSubject('EMB per-page sealed document — do not modify');
  pdf.setKeywords(['EMB', 'sealed', 'CerVer', iisNo]);
}

const UPSERT_SQL = `
  INSERT INTO pages (iis_no, page_no, total_pages, digest, seal, kid, sealed_pdf_path, created_at)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(iis_no, page_no) DO UPDATE SET
    total_pages=excluded.total_pages, digest=excluded.digest, seal=excluded.seal,
    kid=excluded.kid, sealed_pdf_path=excluded.sealed_pdf_path, created_at=excluded.created_at
`;

/**
 * Seal a signed PDF: stamp a per-page footer code and record each page's digest.
 *
 * `at` moves the seal block's bottom-left corner when the usual corner is taken
 * by the page's own content — see findClearSpot in sealFit.js.
 * @returns {Promise<{ sealedBytes: Uint8Array, kid: string, pages: Array }>}
 */
export async function sealPdf(db, { iisNo, pdfBytes, keyProvider, sealedPdfPath = null, at = null }) {
  const kid = keyProvider.currentKid();
  const secret = keyProvider.secretFor(kid);

  const texts = await extractPageTexts(pdfBytes);
  const n = texts.length;

  const src = await PDFDocument.load(pdfBytes);
  const font = await src.embedFont(StandardFonts.Courier);
  const pdfPages = src.getPages();

  const upsert = db ? db.prepare(UPSERT_SQL) : null;
  const now = new Date().toISOString();
  const pages = [];

  for (let i = 0; i < n; i++) {
    const k = i + 1;
    const digest = digestPage(canonicalize(texts[i]));
    const seal = computeSeal(secret, { iisNo, k, n, digest });
    const footer = formatFooter({ iisNo, k, n, kid, seal });

    const pg = pdfPages[i];
    const block = sealBlock(pg.getWidth(), { footer, at });
    await drawSealCode(pg, payloadFor({ iisNo, k, seal }), block.mark);
    // Human-readable seal line directly under the mark, right-aligned with it.
    const w = font.widthOfTextAtSize(footer, block.footer.size);
    pg.drawText(footer, {
      x: Math.max(20, block.footer.x1 - w),
      y: block.footer.y0,
      size: block.footer.size,
      font,
      color: INK,
    });

    if (upsert) upsert.run(iisNo, k, n, digest, seal, kid, sealedPdfPath, now);
    pages.push({ k, n, digest, seal, kid });
  }

  hardenPdf(src, iisNo);
  // updateMetadata:false keeps our Producer/ModDate instead of pdf-lib's default.
  const sealedBytes = await src.save({ updateMetadata: false });
  return { sealedBytes, kid, pages };
}
