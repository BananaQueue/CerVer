import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { checkSealFit } from '../src/sealFit.js';
import { sealRect } from '../src/sealer.js';

const A4 = [595, 842];

// Build a one-page PDF and let the caller draw wherever they like.
async function page(draw) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage(A4);
  p.drawText('Body text well clear of the corner.', { x: 56, y: 700, size: 11, font });
  if (draw) await draw(p, font, doc);
  return doc.save();
}

test('a clear corner reports clear', async () => {
  const r = await checkSealFit(await page());
  assert.equal(r.clear, true);
  assert.equal(r.pages[0].covered.length, 0);
  assert.equal(r.pages[0].images, 0);
});

test('text under the seal is reported, with the words that would be covered', async () => {
  // Put a signature line exactly where the seal lands.
  const seal = sealRect(A4[0]);
  const r = await checkSealFit(
    await page((p, font) => {
      p.drawText('Approved', { x: seal.x0 + 4, y: seal.y0 + 20, size: 9, font });
    })
  );
  assert.equal(r.clear, false);
  assert.deepEqual(r.pages[0].covered, ['Approved']);
});

test('an image under the seal is reported — a scanned signature is the case that matters', async () => {
  const seal = sealRect(A4[0]);
  // A 1x1 PNG stretched over the seal's corner stands in for a signature scan.
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = await checkSealFit(
    await page(async (p, font, doc) => {
      const img = await doc.embedPng(Buffer.from(png, 'base64'));
      p.drawImage(img, { x: seal.x0 + 5, y: seal.y0 + 5, width: 40, height: 40 });
    })
  );
  assert.equal(r.clear, false);
  assert.equal(r.pages[0].images, 1);
});

test('a hairline rule crossing the corner is noted but does not block', async () => {
  // Almost every letterhead has a footer rule running the width of the page. If
  // that counted as a collision the warning would fire on everything and stop
  // being read, so it is reported separately from content.
  const seal = sealRect(A4[0]);
  const r = await checkSealFit(
    await page((p) => {
      p.drawLine({
        start: { x: 56, y: seal.y0 + 28 },
        end: { x: 539, y: seal.y0 + 28 },
        thickness: 0.6,
        color: rgb(0.7, 0.72, 0.7),
      });
    })
  );
  assert.equal(r.clear, true, 'a rule alone must not block sealing');
  assert.equal(r.pages[0].rules, 1);
  assert.deepEqual(r.ruled, [1]);
});

test('content elsewhere on the page is not mistaken for a collision', async () => {
  const r = await checkSealFit(
    await page((p, font) => {
      // Same height as the seal, but over on the left.
      p.drawText('Left footer', { x: 56, y: 50, size: 8, font });
      // Same column, but far up the page.
      p.drawText('Top right', { x: 500, y: 800, size: 8, font });
    })
  );
  assert.equal(r.clear, true);
});

test('the checked rectangle is the one the sealer stamps', async () => {
  const r = await checkSealFit(await page());
  assert.deepEqual(r.seal, sealRect(A4[0]));
});
