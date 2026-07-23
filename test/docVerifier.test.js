import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { sealPdf } from '../src/sealer.js';
import { formatFooter } from '../src/sealCode.js';
import { verifyDocument } from '../src/docVerifier.js';
import { makePdf, makePdfWithFooters } from './fixtures/make-pdf.js';

const kp = { currentKid: () => '1', secretFor: () => 'test-secret' };
const BODIES = ['Page one body.', 'Page two body.', 'Page three body.'];

async function sealFixture() {
  const pdf = await makePdf(BODIES);
  const { sealedBytes, pages } = await sealPdf(null, {
    iisNo: 'R1-2026-000001',
    pdfBytes: pdf,
    keyProvider: kp,
  });
  const footers = pages.map((p) => formatFooter({ iisNo: 'R1-2026-000001', ...p }));
  return { sealedBytes, footers };
}

test('genuine sealed document -> intact, all pages verified', async () => {
  const { sealedBytes } = await sealFixture();
  const report = await verifyDocument(openDb(':memory:'), sealedBytes, { keyProvider: kp });
  assert.equal(report.document.status, 'intact');
  assert.equal(report.document.actualPages, 3);
  assert.deepEqual(report.pages.map((p) => p.status), ['verified', 'verified', 'verified']);
  assert.equal(report.findings.length, 0);
});

test('altered body with genuine footer -> that page flagged content_altered', async () => {
  const { footers } = await sealFixture();
  // Attacker keeps the genuine footers but edits page 2's body.
  const forged = await makePdfWithFooters([
    { body: BODIES[0], footer: footers[0] },
    { body: 'Page two body. AMOUNT CHANGED TO 500000', footer: footers[1] },
    { body: BODIES[2], footer: footers[2] },
  ]);
  const report = await verifyDocument(null, forged, { keyProvider: kp });
  assert.equal(report.document.status, 'tampered');
  assert.equal(report.pages[1].status, 'content_altered');
  assert.equal(report.pages[0].status, 'verified');
  assert.ok(report.findings.some((f) => /Page 2.*altered/.test(f)));
});

test('inserted unsealed page is detected', async () => {
  const { footers } = await sealFixture();
  const forged = await makePdfWithFooters([
    { body: BODIES[0], footer: footers[0] },
    { body: 'Sneaky inserted page', footer: null },
    { body: BODIES[1], footer: footers[1] },
    { body: BODIES[2], footer: footers[2] },
  ]);
  const report = await verifyDocument(null, forged, { keyProvider: kp });
  assert.equal(report.document.status, 'tampered');
  assert.ok(report.findings.some((f) => /position 2 carries no seal/.test(f)));
});
