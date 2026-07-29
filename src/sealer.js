import { PDFDocument, StandardFonts, PDFName, rgb } from 'pdf-lib';
import { extractPageTexts } from './pdfTools.js';
import { canonicalize, digestPage, computeSeal, formatFooter, payloadFor } from './sealCode.js';
import { dataMatrixPng } from './barcode.js';

const INK = rgb(0.043, 0.239, 0.18); // EMB pine green

// Draw the scannable Data Matrix (encoding CVR|iisNo|k|seal) in the lower-right
// corner, above the human-readable seal line. The camera reads this to verify.
async function drawDataMatrix(pdf, pg, payload) {
  const png = await dataMatrixPng(payload, { scale: 5 });
  const img = await pdf.embedPng(png);
  const size = 42; // pt, ~1.5 cm
  const margin = 30;
  const x = pg.getWidth() - margin - size;
  const y = 40; // sits above the seal line (baseline y=26)
  pg.drawImage(img, { x, y, width: size, height: size });
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
    await drawDataMatrix(src, pg, payloadFor({ iisNo, k, seal }));
    // Human-readable seal line under the Data Matrix, right-aligned to the margin.
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
