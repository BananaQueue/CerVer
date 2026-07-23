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
