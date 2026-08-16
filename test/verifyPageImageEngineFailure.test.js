import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { sealPdf } from '../src/sealer.js';
import { makePdf } from './fixtures/make-pdf.js';
import { verifyPageImage } from '../src/verifyPageImage.js';

// Companion to test/verifyPageImage.test.js, added separately (rather than
// appended there) so that file is left untouched per task constraints.
//
// Covers task 7 fix 2a: an OCR ENGINE failure (worker won't start, or crashes
// mid-recognition) must propagate out of verifyPageImage rather than being
// swallowed or misreported as image_unreadable -- spec §7 reserves
// image_unreadable for "OCR read the image and found too little", which is a
// different fact than "the engine itself is broken".

const kp = { currentKid: () => '1', secretFor: () => 'test-secret' };
const BODY = [
  'ORDER OF THE REGIONAL DIRECTOR. Issued to ACME MINING CORPORATION.',
  'A fine of P50,000.00 is imposed under Section 12 of the rules, and the',
  'respondent shall comply within 15 days of receipt of this order.',
].join('\n');

async function seed() {
  const db = openDb(':memory:');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerver-ocr-engine-fail-'));
  const pdf = await makePdf([BODY, 'Second page body text goes here.']);
  const { sealedBytes } = await sealPdf(db, {
    iisNo: 'R1-2026-000001', pdfBytes: pdf, keyProvider: kp,
  });
  const file = path.join(dir, 'sealed.pdf');
  await fs.writeFile(file, Buffer.from(sealedBytes));
  db.prepare('UPDATE pages SET sealed_pdf_path=? WHERE iis_no=?')
    .run(file, 'R1-2026-000001');
  return { db, dir };
}

test('an OCR engine failure propagates out of verifyPageImage, message names it as an engine failure', async () => {
  const { db } = await seed();
  // A mid-recognition crash: the kind of rejection that does NOT already carry
  // the "OCR engine failed to start:" prefix ocr.js's worker-start timeout
  // uses, so this exercises the general case, not just the one lucky prefix.
  const crashingOcr = async () => { throw new Error('tesseract native module crashed'); };

  let caught = null;
  try {
    await verifyPageImage(db, Buffer.alloc(1), {
      iisNo: 'R1-2026-000001', k: 1, ocr: crashingOcr,
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'verifyPageImage must reject, not resolve, when the OCR engine throws');
  // The original message must survive somewhere in what propagates (not
  // swallowed / replaced), AND the propagated message must itself be
  // identifiable as an engine failure (not just the bare original text),
  // so the route (src/app.js) can tell an engine failure apart from any
  // other kind of rejection without inspecting types.
  assert.match(caught.message, /tesseract native module crashed/);
  assert.match(caught.message, /OCR engine/i);
});

test('an OCR engine failure is never reported as image_unreadable', async () => {
  const { db } = await seed();
  const crashingOcr = async () => { throw new Error('worker pipe closed'); };

  let resolvedTo = null;
  let rejected = false;
  try {
    resolvedTo = await verifyPageImage(db, Buffer.alloc(1), {
      iisNo: 'R1-2026-000001', k: 1, ocr: crashingOcr,
    });
  } catch {
    rejected = true;
  }

  assert.equal(rejected, true, 'must reject rather than resolve to a report');
  assert.equal(resolvedTo, null);
});
