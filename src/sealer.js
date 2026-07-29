import { PDFDocument, StandardFonts, PDFName, rgb, degrees } from 'pdf-lib';
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

// EXPERIMENTAL: stamp a LeafCode in the lower-right, tilted, with a stem.
//
// It needs far more page area than the Data Matrix: 256 nodes at 24 canonical
// units of spacing only survive scanning if the whole leaf is large enough.
// Minimum practical size: the code needs ~300 px of resolution to decode, i.e.
// ~72 pt (25 mm) at 300 dpi. 110 pt (~39 mm) keeps a real margin over that
// cliff while staying visually modest on the page.
const LEAF_SIZE = 110;
const LEAF_ANGLE = -18; // tilted, so it reads as a leaf rather than a data block

async function drawLeafCode(pdf, pg, bits, { size = LEAF_SIZE, margin = 26 } = {}) {
  const [{ rasterize }, { rgbaToGrayPng }] = await Promise.all([
    import('./leafcode/raster.js'),
    import('./leafcode/png.js'),
  ]);
  // Rasterise with the SAME code path Gate A validates, then embed those exact
  // pixels. Drawing the lattice with PDF primitives instead would duplicate the
  // geometry a fourth time and risk drifting from what the decoder expects.
  const png = rgbaToGrayPng(rasterize(bits, { px: 1000 }));
  const img = await pdf.embedPng(png);

  // Centre of where the leaf should sit (lower-right, above the seal line).
  const cx = pg.getWidth() - margin - size / 2;
  const cy = 46 + size / 2;

  const th = (LEAF_ANGLE * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  // pdf-lib rotates an image about its lower-left corner, so offset the anchor
  // such that the image's CENTRE lands on (cx, cy).
  const h = size / 2;
  const ax = cx - (h * cos - h * sin);
  const ay = cy - (h * sin + h * cos);

  pg.drawImage(img, { x: ax, y: ay, width: size, height: size, rotate: degrees(LEAF_ANGLE) });

  // Map a point given in the image's own unit square (origin lower-left) onto
  // the page, through the same rotation the image got.
  const local = (lx, ly) => ({
    x: ax + lx * size * cos - ly * size * sin,
    y: ay + lx * size * sin + ly * size * cos,
  });

  // raster.js draws only the dots and anchors, so the botanical silhouette and
  // stem are added here as vectors.
  //
  // They MUST stay pale. The decoder thresholds the crop with Otsu (black dots
  // vs white paper, so the threshold lands near mid-grey) and then treats the
  // largest dark blobs as anchor candidates. An outline stroke is one long
  // connected component — at this scale it measures ~20x an anchor's area — so
  // if it survives thresholding it displaces the real anchors and decoding
  // fails outright. Keeping the decoration well above the threshold makes it
  // read as background to the decoder while still being visible to a person.
  // Measured: on a rendered page the crop is overwhelmingly white, so Otsu's
  // threshold sits high (~213). Decoration at grey 170 was therefore still
  // "dark" and merged neighbouring dots into a single 23,000 px blob. Grey ~235
  // sits clear of that threshold and reads as background.
  const DECOR = rgb(0.9, 0.93, 0.9); // ~grey 234
  const { lattice, SPACE } = await import('./leafcode/lattice.js');
  const { hw, P } = lattice();
  const toLocal = (u, side) => {
    const p = P(u, side * hw(u));
    return local(p.x / SPACE, 1 - p.y / SPACE);
  };
  const STEPS = 40;
  const pts = [];
  for (let i = 0; i <= STEPS; i++) pts.push(toLocal(i / STEPS, 1));
  for (let i = STEPS; i >= 0; i--) pts.push(toLocal(i / STEPS, -1));
  for (let i = 0; i < pts.length - 1; i++) {
    pg.drawLine({
      start: pts[i],
      end: pts[i + 1],
      thickness: 0.45,
      color: DECOR,
    });
  }

  // Stem: continues straight out from the leaf's base, along the same tilt.
  const baseU = toLocal(0, 1); // u=0 is the base of the midrib
  const tail = local(0.5, 1 - 910 / SPACE - 0.16);
  pg.drawLine({
    start: { x: baseU.x, y: baseU.y },
    end: tail,
    thickness: 1.2,
    color: DECOR,
  });
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
export async function sealPdf(
  db,
  { iisNo, pdfBytes, keyProvider, sealedPdfPath = null, mark = 'datamatrix', leafSize = LEAF_SIZE }
) {
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
    const payload = payloadFor({ iisNo, k, seal });
    if (mark === 'datamatrix' || mark === 'both') {
      await drawDataMatrix(src, pg, payload);
    }
    if (mark === 'leafcode' || mark === 'both') {
      const { encode } = await import('./leafcode/codec.js');
      // When both marks are present the Data Matrix keeps the corner, so shift
      // the leaf left to sit beside it rather than on top of it.
      await drawLeafCode(src, pg, encode(payload), {
        size: leafSize,
        margin: mark === 'both' ? 84 : 26,
      });
    }
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
