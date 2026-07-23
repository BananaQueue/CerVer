import { PDFDocument, StandardFonts } from 'pdf-lib';

// Build a multi-page PDF with distinct, extractable text on each page.
export async function makePdf(bodies) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const body of bodies) {
    const p = doc.addPage([595, 842]);
    p.drawText(body, { x: 50, y: 780, size: 12, font });
  }
  return doc.save();
}

// Build a PDF with explicit footer lines — used to forge a document that keeps
// genuine footers on altered/rearranged bodies.
export async function makePdfWithFooters(entries) {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const foot = await doc.embedFont(StandardFonts.Courier);
  for (const { body: text, footer } of entries) {
    const p = doc.addPage([595, 842]);
    p.drawText(text, { x: 50, y: 780, size: 12, font: body });
    if (footer) p.drawText(footer, { x: 40, y: 24, size: 8, font: foot });
  }
  return doc.save();
}
