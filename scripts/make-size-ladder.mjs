// Append a calibration sheet to the sealed print test: the SAME payload as
// page 1, printed at four sizes with generous clearance. Screen rasterisation
// cannot answer what the size floor is on paper — toner spread, paper fibre and
// camera optics only show up once it is printed — so this is the sheet that
// actually gets photographed.
//
//   node scripts/make-size-ladder.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tilesFor, SIZE } from '../src/sealcode/encode.js';
import { openDb } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, 'print-test-sealed.pdf');
const IIS_NO = 'R1-2026-010734';
const MM = [30, 26, 22, 18];

const db = openDb(path.resolve('cerver.db'));
const row = db
  .prepare('SELECT seal FROM pages WHERE iis_no = ? AND page_no = 1')
  .get(IIS_NO);
if (!row) throw new Error(`no sealed page 1 for ${IIS_NO} — run seal-print-test.mjs first`);
const payload = `CVR|${IIS_NO}|1|${row.seal}`;

const pdf = await PDFDocument.load(await readFile(FILE));
const font = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const pg = pdf.addPage([595, 842]);

const tiles = tilesFor(payload);
function drawAt(x0, yTop, mm) {
  const size = (mm / 25.4) * 72;
  const t = size / SIZE;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!tiles[r][c]) continue;
      pg.drawRectangle({
        x: x0 + c * t,
        y: yTop - size + (SIZE - 1 - r) * t,
        width: t + 0.12,
        height: t + 0.12,
        color: rgb(0.05, 0.05, 0.05),
      });
    }
  }
  return size;
}

pg.drawText('SEAL CODE — PRINT CALIBRATION SHEET', { x: 56, y: 790, size: 12, font: bold });
pg.drawText(`Payload: ${payload}`, { x: 56, y: 772, size: 9, font });
pg.drawText(
  'Photograph each mark on its own, filling the frame. Note the smallest one that reads.',
  { x: 56, y: 758, size: 9, font, color: rgb(0.35, 0.4, 0.36) }
);

// Two columns, two rows, each mark well clear of its neighbours so nothing else
// can be dragged into the decoder's bounding box.
const cols = [90, 330];
const rowsY = [700, 420];
MM.forEach((mm, i) => {
  const x = cols[i % 2];
  const yTop = rowsY[Math.floor(i / 2)];
  const size = drawAt(x, yTop, mm);
  pg.drawText(`${mm} mm  ·  ${(mm / 44).toFixed(2)} mm per tile`, {
    x, y: yTop - size - 16, size: 9, font,
  });
});

await writeFile(FILE, await pdf.save({ updateMetadata: false }));
console.log(`appended calibration sheet (${MM.join('/')} mm) to ${FILE}`);
