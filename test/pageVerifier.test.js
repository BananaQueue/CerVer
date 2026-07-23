import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { sealPdf } from '../src/sealer.js';
import { extractPageTexts } from '../src/pdfTools.js';
import { parseFooter, formatFooter } from '../src/sealCode.js';
import { createPageVerifier } from '../src/pageVerifier.js';
import { makePdf } from './fixtures/make-pdf.js';

const kp = { currentKid: () => '1', secretFor: () => 'test-secret' };

async function seed() {
  const db = openDb(':memory:');
  const pdf = await makePdf(['Body one.', 'Body two.', 'Body three.']);
  const { sealedBytes } = await sealPdf(db, { iisNo: 'R1-2026-000001', pdfBytes: pdf, keyProvider: kp });
  const texts = await extractPageTexts(sealedBytes);
  return { db, footer: parseFooter(texts[1]) }; // page 2's genuine footer
}

test('authentic code -> page_verified', async () => {
  const { db, footer } = await seed();
  const verify = createPageVerifier({ db, keyProvider: kp });
  const r = verify(formatFooter(footer));
  assert.equal(r.status, 'page_verified');
  assert.equal(r.k, 2);
});

test('forged seal -> invalid_seal', async () => {
  const { db, footer } = await seed();
  const verify = createPageVerifier({ db, keyProvider: kp });
  const bad = formatFooter({ ...footer, seal: 'AAAA-AAAA' });
  assert.equal(verify(bad).status, 'invalid_seal');
});

test('wrong page count -> page_count_mismatch', async () => {
  const { db, footer } = await seed();
  const verify = createPageVerifier({ db, keyProvider: kp });
  assert.equal(verify(formatFooter({ ...footer, n: 9 })).status, 'page_count_mismatch');
});

test('unknown document -> not_sealed', async () => {
  const { db } = await seed();
  const verify = createPageVerifier({ db, keyProvider: kp });
  const r = verify('EMB · R1-2099-999999 · p1/1 · K1 · AAAA-AAAA');
  assert.equal(r.status, 'not_sealed');
});

test('staff path exposes authoritative page pointer', async () => {
  const { db, footer } = await seed();
  const verify = createPageVerifier({ db, keyProvider: kp });
  const r = verify(formatFooter(footer), { path: 'staff' });
  assert.equal(r.status, 'page_verified');
  assert.equal(r.authoritative.pageNo, 2);
});
