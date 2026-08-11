import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { checkSealFit, findClearSpot, SAMPLE_FOOTER } from '../src/sealFit.js';
import { sealRect, sealBlock } from '../src/sealer.js';

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

test('the checked rectangle is the whole block the sealer stamps', async () => {
  // Not just the mark: the human-readable line moves with it and is the fallback
  // when nothing scans, so it has to be clear of the page's content too.
  const r = await checkSealFit(await page());
  assert.deepEqual(r.seal, sealBlock(A4[0], { footer: SAMPLE_FOOTER }).block);

  const block = sealBlock(A4[0], { footer: SAMPLE_FOOTER });
  assert.ok(block.footer.y1 <= block.mark.y0, 'the line sits below the mark');
  assert.ok(block.footer.x1 === block.mark.x1, 'the line is right-aligned with the mark');
  assert.ok(block.block.x0 <= block.footer.x0, 'the block covers the line');
});

test('a spot is found when the usual corner is occupied', async () => {
  const home = sealBlock(A4[0], { footer: SAMPLE_FOOTER });
  const pdf = await page(async (p, font, doc) => {
    // Fill the whole footer band, as a real EMB order does with its own QR,
    // address block and certification mark.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const img = await doc.embedPng(Buffer.from(png, 'base64'));
    p.drawImage(img, { x: 20, y: 20, width: 555, height: home.block.y1 });
  });

  assert.equal((await checkSealFit(pdf)).clear, false, 'the usual place must be blocked');

  const found = await findClearSpot(pdf);
  assert.equal(found.found, true, 'somewhere on the page must still be free');
  assert.ok(found.spot.y0 >= home.block.y1, 'the spot must clear the occupied band');

  // And sealing there must actually come out clear.
  const at = { x0: found.spot.x0, y0: found.spot.y0 };
  assert.equal((await checkSealFit(pdf, { at })).clear, true);
});

test('POST /api/seal accepts a position, and the sealed page is then clear', async () => {
  // The whole point of finding a spot is being able to seal there. This walks
  // the route staff take: check, find, seal at the found position.
  const { openDb } = await import('../src/db.js');
  const { createVerifier } = await import('../src/verifyService.js');
  const { keyProvider } = await import('../src/sealKeys.js');
  const { buildApp } = await import('../src/app.js');

  const home = sealBlock(A4[0], { footer: SAMPLE_FOOTER });
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pdf = await page(async (p, font, doc) => {
    const img = await doc.embedPng(Buffer.from(png, 'base64'));
    p.drawImage(img, { x: 20, y: 20, width: 555, height: home.block.y1 });
  });

  const db = openDb(':memory:');
  const keys = keyProvider();
  const app = buildApp({ db, verify: createVerifier({ db, iisLookup: async () => null }), keyProvider: keys });

  const found = await findClearSpot(pdf);
  assert.equal(found.found, true);

  const form = new FormData();
  form.append('iisNo', 'R1-2026-000123');
  form.append('at', JSON.stringify({ x0: found.spot.x0, y0: found.spot.y0 }));
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'in.pdf');

  const res = await app.inject({ method: 'POST', url: '/api/seal', payload: form });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-sealed-pages'], '1');

  // The sealed output must have the mark clear of what was already there.
  const sealed = Buffer.from(res.rawPayload);
  const after = await checkSealFit(sealed, { at: { x0: found.spot.x0, y0: found.spot.y0 } });
  assert.equal(
    after.pages[0].images,
    0,
    'the seal must not have landed on the image it was moved to avoid'
  );
});
