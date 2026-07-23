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
