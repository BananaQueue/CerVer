import { PDFDocument, StandardFonts, PDFName, rgb, degrees } from 'pdf-lib';
import { extractPageTexts } from './pdfTools.js';
import { canonicalize, digestPage, computeSeal, formatFooter, payloadFor } from './sealCode.js';

const INK = rgb(0.043, 0.239, 0.18); // EMB pine green

// The EMB seal code: the DENR/EMB logo pixelated to a 44x44 tile grid, with the
// payload carried by clearing interior tiles. Drawn as vector rectangles rather
// than an embedded raster so it stays crisp at any print resolution.
//
// 18 mm — 0.41 mm per tile — is where the calibration sheet settled. It printed
// on an office inkjet and read back off the paper, which is the only test that
// counts; the larger rungs were never needed. It also carries the mark itself at
// a size that reads as the EMB seal rather than as a machine code.
const SEALCODE_MM = 18;

async function drawSealCode(pg, payload, { mm = SEALCODE_MM, margin = 26 } = {}) {
  const { tilesFor, SIZE } = await import('./sealcode/encode.js');
  const tiles = tilesFor(payload);
  const size = (mm / 25.4) * 72; // mm -> points
  const t = size / SIZE;
  const x0 = pg.getWidth() - margin - size;
  const y0 = 34;
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
 * @returns {Promise<{ sealedBytes: Uint8Array, kid: string, pages: Array }>}
 */
export async function sealPdf(db, { iisNo, pdfBytes, keyProvider, sealedPdfPath = null }) {
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
    await drawSealCode(pg, payloadFor({ iisNo, k, seal }));
    // Human-readable seal line under the mark, right-aligned to the margin.
    const size = 6;
    const w = font.widthOfTextAtSize(footer, size);
    const x = Math.max(20, pg.getWidth() - 30 - w);
    pg.drawText(footer, { x, y: 26, size, font, color: INK });

    if (upsert) upsert.run(iisNo, k, n, digest, seal, kid, sealedPdfPath, now);
    pages.push({ k, n, digest, seal, kid });
  }

  hardenPdf(src, iisNo);
  // updateMetadata:false keeps our Producer/ModDate instead of pdf-lib's default.
  const sealedBytes = await src.save({ updateMetadata: false });
  return { sealedBytes, kid, pages };
}
