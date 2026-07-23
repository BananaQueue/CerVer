import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { openDb } from '../src/db.js';
import { sealPdf } from '../src/sealer.js';
import { extractPageTexts } from '../src/pdfTools.js';
import { parseFooter, stripFooter, digestPage, computeSeal } from '../src/sealCode.js';
import { makePdf } from './fixtures/make-pdf.js';

const kp = {
  currentKid: () => '1',
  secretFor: () => 'test-secret',
};

test('sealPdf stamps every page, records rows, and the printed seals verify', async () => {
  const pdf = await makePdf([
    'Page one: travel order for Juan Dela Cruz.',
    'Page two: destination Manila, three days.',
    'Page three: approved amount PHP 5000.',
  ]);
  const db = openDb(':memory:');

  const { sealedBytes, pages } = await sealPdf(db, {
    iisNo: 'R1-2026-000001',
    pdfBytes: pdf,
    keyProvider: kp,
  });

  assert.equal(pages.length, 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM pages').get().c, 3);

  // Re-extract from the SEALED pdf: strip our footer, recompute the digest, and
  // confirm the printed seal matches — proving the whole round-trip is consistent.
  const texts = await extractPageTexts(sealedBytes);
  assert.equal(texts.length, 3);
  for (let i = 0; i < 3; i++) {
    const parsed = parseFooter(texts[i]);
    assert.ok(parsed, `page ${i + 1} has a parseable footer`);
    assert.equal(parsed.k, i + 1);
    assert.equal(parsed.n, 3);
    const digest = digestPage(stripFooter(texts[i]));
    const expected = computeSeal('test-secret', {
      iisNo: 'R1-2026-000001',
      k: i + 1,
      n: 3,
      digest,
    });
    assert.equal(parsed.seal, expected, `page ${i + 1} seal verifies against its content`);
    // and it equals what we stored
    const row = db.prepare('SELECT * FROM pages WHERE iis_no=? AND page_no=?').get('R1-2026-000001', i + 1);
    assert.equal(row.seal, parsed.seal);
    assert.equal(row.digest, digest);
  }
});

test('sealed PDF carries hardening metadata and stays text-extractable', async () => {
  const pdf = await makePdf(['Only page body.']);
  const { sealedBytes } = await sealPdf(null, {
    iisNo: 'R1-2026-000009',
    pdfBytes: pdf,
    keyProvider: kp,
  });
  const doc = await PDFDocument.load(sealedBytes);
  assert.match(doc.getTitle(), /Sealed document R1-2026-000009 — CerVer/);
  assert.match(doc.getSubject(), /do not modify/);
  // text layer preserved -> Full-check still works
  const texts = await extractPageTexts(sealedBytes);
  assert.ok(parseFooter(texts[0]));
});
