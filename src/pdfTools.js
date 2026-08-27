import { PDFDocument } from 'pdf-lib';

// Shared PDF-load/iterate step behind both extraction functions below. Not
// exported: extractPageTextsWithLines is the one sanctioned way to get
// line-aware record text (see docs/superpowers/specs/
// 2026-08-25-record-line-preserving-extraction-design.md).
async function getPageItems(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = Uint8Array.from(bytes); // copy — pdfjs may detach the buffer
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true })
    .promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items);
  }
  await pdf.cleanup();
  return pages;
}

// Extract the text of every page. Returns an array; index 0 = page 1.
// Feeds the sealing digest (src/sealer.js) and every other caller — output
// is unchanged from before the getPageItems refactor, verified in
// test/pdfTools.test.js.
export async function extractPageTexts(bytes) {
  const pages = await getPageItems(bytes);
  return pages.map((items) => items.map((x) => x.str).join(' '));
}

// Same pages, same indexing, but keeps real line breaks: pdf.js reports
// item.hasEOL when an item is immediately followed by a line break in the
// PDF's own text flow. Comparison-only (src/verifyPageImage.js) — never
// used for sealing. See docs/superpowers/specs/
// 2026-08-25-record-line-preserving-extraction-design.md.
export async function extractPageTextsWithLines(bytes) {
  const pages = await getPageItems(bytes);
  return pages.map((items) => {
    let out = '';
    items.forEach((item, i) => {
      out += item.str;
      if (i < items.length - 1) out += item.hasEOL ? '\n' : ' ';
    });
    return out;
  });
}

// Extract a single page (1-based) into its own one-page PDF, for staff preview.
export async function extractSinglePage(bytes, k) {
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const [pg] = await out.copyPages(src, [k - 1]);
  out.addPage(pg);
  return out.save();
}
