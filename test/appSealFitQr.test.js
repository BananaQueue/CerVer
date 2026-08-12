import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createVerifier } from '../src/verifyService.js';
import { keyProvider } from '../src/sealKeys.js';
import { buildApp } from '../src/app.js';
import { makePdf } from './fixtures/make-pdf.js';

// The QR fallback is injected, so these run without launching a browser. What is
// under test is when it is consulted and how its answer is reported — not the
// browser work itself, which is exercised against the real Special Order by hand.

const appWith = (resolveQr) => {
  const db = openDb(':memory:');
  return buildApp({
    db,
    verify: createVerifier({ db, iisLookup: async () => null }),
    keyProvider: keyProvider(),
    resolveQr,
  });
};

function multipart(pdfBytes) {
  const b = '----cerver' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="doc.pdf"\r\n` +
      'Content-Type: application/pdf\r\n\r\n'
  );
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
    payload: Buffer.concat([head, Buffer.from(pdfBytes), Buffer.from(`\r\n--${b}--\r\n`)]),
  };
}

const post = (app, pdf) => app.inject({ method: 'POST', url: '/api/seal-fit', ...multipart(pdf) });

test('the document is not sent to IIS when its own text answers', async () => {
  let called = 0;
  const app = appWith(async () => { called++; return { ok: false, reason: 'no-qr' }; });
  const r = await post(app, await makePdf(['Control No. R1-2026-010734']));

  const body = JSON.parse(r.body);
  assert.equal(body.iisNo, 'R1-2026-010734');
  assert.equal(body.source, 'text');
  assert.equal(called, 0, 'no lookup should happen when the text already says');
});

test('falls back to the QR when the number is blank in the text', async () => {
  // The real Special Order shape: "No. 25- ______ Series of 2025".
  const app = appWith(async () => ({
    ok: true,
    iisNo: 'R1-2025-025065',
    record: { iisNo: 'R1-2025-025065', subject: 'AUTHORIZING THE CONDUCT', status: 'Active', division: 'R1 - EMED', companyName: 'EMB R1' },
    url: 'https://iis.emb.gov.ph/verify/status?q=x',
    page: 1,
  }));
  const r = await post(app, await makePdf(['SPECIAL ORDER No. 25- ______ Series of 2025']));

  const body = JSON.parse(r.body);
  assert.equal(body.iisNo, 'R1-2025-025065');
  assert.equal(body.source, 'iis');
  assert.equal(body.record.subject, 'AUTHORIZING THE CONDUCT');
  assert.equal(body.lookup.ok, true);
});

test('says it could not reach IIS rather than failing the upload', async () => {
  const app = appWith(async () => ({ ok: false, reason: 'unreachable', detail: 'net::ERR' }));
  const r = await post(app, await makePdf(['SPECIAL ORDER No. 25- ______ Series of 2025']));

  assert.equal(r.statusCode, 200, 'the pre-flight still answers');
  const body = JSON.parse(r.body);
  assert.equal(body.iisNo, null);
  assert.equal(body.lookup.ok, false);
  assert.equal(body.lookup.reason, 'unreachable');
  assert.ok('clear' in body, 'the fit report survives a failed lookup');
});

test('a lookup that throws is reported, not propagated', async () => {
  const app = appWith(async () => { throw new Error('chrome missing'); });
  const r = await post(app, await makePdf(['SPECIAL ORDER No. 25- ______']));

  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.iisNo, null);
  assert.equal(body.lookup.reason, 'unreachable');
});

test('a document with no QR is distinguished from IIS being down', async () => {
  const app = appWith(async () => ({ ok: false, reason: 'no-qr' }));
  const r = await post(app, await makePdf(['Nothing useful here']));
  assert.equal(JSON.parse(r.body).lookup.reason, 'no-qr');
});
