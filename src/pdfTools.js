import { PDFDocument } from 'pdf-lib';

// Extract the text of every page. Returns an array; index 0 = page 1.
export async function extractPageTexts(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = Uint8Array.from(bytes); // copy — pdfjs may detach the buffer
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true })
    .promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    out.push(tc.items.map((x) => x.str).join(' '));
  }
  await pdf.cleanup();
  return out;
}

// Extract a single page (1-based) into its own one-page PDF, for staff preview.
export async function extractSinglePage(bytes, k) {
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const [pg] = await out.copyPages(src, [k - 1]);
  out.addPage(pg);
  return out.save();
}
