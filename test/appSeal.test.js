import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createVerifier } from '../src/verifyService.js';
import { keyProvider } from '../src/sealKeys.js';
import { sealPdf } from '../src/sealer.js';
import { extractPageTexts } from '../src/pdfTools.js';
import { parseFooter, formatFooter } from '../src/sealCode.js';
import { buildApp } from '../src/app.js';
import { makePdf } from './fixtures/make-pdf.js';

test('GET /api/verify-page validates a genuine page seal', async () => {
  const db = openDb(':memory:');
  const keys = keyProvider();
  const pdf = await makePdf(['Alpha body.', 'Beta body.']);
  const { sealedBytes } = await sealPdf(db, {
    iisNo: 'R1-2026-000042',
    pdfBytes: pdf,
    keyProvider: keys,
  });
  const footer = parseFooter((await extractPageTexts(sealedBytes))[0]);

  const verify = createVerifier({ db, iisLookup: async () => null });
  const app = buildApp({ db, verify, keyProvider: keys });

  const ok = await app.inject({
    method: 'GET',
    url: '/api/verify-page',
    query: { line: formatFooter(footer) },
  });
  assert.equal(ok.json().status, 'page_verified');

  const bad = await app.inject({
    method: 'GET',
    url: '/api/verify-page',
    query: { line: formatFooter({ ...footer, seal: 'AAAA-AAAA' }) },
  });
  assert.equal(bad.json().status, 'invalid_seal');
  await app.close();
});

test('GET /api/pages lists the footer printed on every page', async () => {
  // The physical cross-reference: someone holding a sheet reads the footer off
  // the paper and has to find it here. So the listed line must be byte-for-byte
  // what the sealer stamped, not a reconstruction of it.
  const db = openDb(':memory:');
  const keys = keyProvider();
  const pdf = await makePdf(['One.', 'Two.', 'Three.']);
  const { sealedBytes } = await sealPdf(db, {
    iisNo: 'R1-2026-000077',
    pdfBytes: pdf,
    keyProvider: keys,
    sealedPdfPath: '/tmp/x.pdf',
  });

  const verify = createVerifier({ db, iisLookup: async () => null });
  const app = buildApp({ db, verify, keyProvider: keys });

  const res = await app.inject({ method: 'GET', url: '/api/pages/R1-2026-000077' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.total, 3);
  assert.equal(body.pages.length, 3);

  const printed = (await extractPageTexts(sealedBytes)).map((t) => formatFooter(parseFooter(t)));
  assert.deepEqual(body.pages.map((p) => p.footer), printed);
  assert.deepEqual(body.pages.map((p) => p.k), [1, 2, 3]);

  // A document with nothing sealed must not look like a document with pages.
  const none = await app.inject({ method: 'GET', url: '/api/pages/R1-2026-999999' });
  assert.deepEqual(none.json(), { iisNo: 'R1-2026-999999', total: 0, pages: [] });
});
