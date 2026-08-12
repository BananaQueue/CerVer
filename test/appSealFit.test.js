import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createVerifier } from '../src/verifyService.js';
import { keyProvider } from '../src/sealKeys.js';
import { buildApp } from '../src/app.js';
import { makePdf } from './fixtures/make-pdf.js';

// The pre-flight already receives and parses the PDF, so it is where the control
// number is read off it — no second upload, no new endpoint.

const appFor = () => {
  const db = openDb(':memory:');
  return buildApp({
    db,
    verify: createVerifier({ db, iisLookup: async () => null }),
    keyProvider: keyProvider(),
    // Never let the suite reach the real IIS: it would be slow, flaky, and would
    // put test traffic on a shared production system. The QR path has its own
    // tests in appSealFitQr.test.js.
    resolveQr: async () => ({ ok: false, reason: 'no-qr' }),
  });
};

/** multipart/form-data body with one PDF part. */
function multipart(pdfBytes) {
  const b = '----cerver' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="doc.pdf"\r\n` +
      'Content-Type: application/pdf\r\n\r\n'
  );
  const tail = Buffer.from(`\r\n--${b}--\r\n`);
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
    payload: Buffer.concat([head, Buffer.from(pdfBytes), tail]),
  };
}

test('seal-fit reports the control number printed on the document', async () => {
  const pdf = await makePdf([
    'Control No. R1-2026-010734\nSUBJECT: Inspection',
    'Page two body. Control No. R1-2026-010734',
  ]);
  const r = await appFor().inject({ method: 'POST', url: '/api/seal-fit', ...multipart(pdf) });

  assert.equal(r.statusCode, 200, r.body.slice(0, 200));
  const body = JSON.parse(r.body);
  assert.equal(body.iisNo, 'R1-2026-010734');
  assert.equal(body.candidates.length, 1);
  assert.deepEqual(body.candidates[0].pages, [1, 2]);
  assert.equal(body.candidates[0].labelled, true);
});

test('seal-fit still reports the fit, so detection is additive', async () => {
  const pdf = await makePdf(['Control No. R1-2026-010734']);
  const r = await appFor().inject({ method: 'POST', url: '/api/seal-fit', ...multipart(pdf) });
  const body = JSON.parse(r.body);
  assert.ok('clear' in body, 'fit report is still present');
  assert.ok(Array.isArray(body.pages), 'per-page fit is still present');
});

test('seal-fit says so when there is no control number to find', async () => {
  // The Special Order case: numbered in a form the mark cannot carry.
  const pdf = await makePdf(['SPECIAL ORDER No. 25-506  Series of 2025']);
  const r = await appFor().inject({ method: 'POST', url: '/api/seal-fit', ...multipart(pdf) });

  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.iisNo, null);
  assert.deepEqual(body.candidates, []);
});
