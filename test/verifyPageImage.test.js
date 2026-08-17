import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { sealPdf } from '../src/sealer.js';
import { makePdf } from './fixtures/make-pdf.js';
import { verifyPageImage } from '../src/verifyPageImage.js';

const kp = { currentKid: () => '1', secretFor: () => 'test-secret' };
// Joined with '\n', not ' ': makePdf draws each body as one unwrapped line
// (see test/fixtures/make-pdf.js), and this sentence is long enough that a
// single-line layout runs past the page's right edge. pdfjs-dist's text
// extraction silently drops what falls off the page — verified by hand: with
// ' ' as the join, extractPageTexts truncated this exact string mid-word at
// "P50,00", well short of THRESHOLDS.minWords once the footer's stripped, and
// samePageMin (0.6) then made a faithful reading of the page fail its own
// "compares clean" test as page_differs. '\n' makes drawText emit each
// sentence as a separate line (pdf-lib's default lineSplit), keeping every
// line short enough to survive extraction whole; extractPageTexts joins all
// items with a single space regardless, so this is invisible downstream.
const BODY = [
  'ORDER OF THE REGIONAL DIRECTOR. Issued to ACME MINING CORPORATION.',
  'A fine of P50,000.00 is imposed under Section 12 of the rules, and the',
  'respondent shall comply within 15 days of receipt of this order.',
].join('\n');

// The image is never opened in these tests — a stub stands in for the engine, so
// the suite stays deterministic and offline. Task 8 exercises the real one.
const stubOcr = (text, meanConfidence = 0.9, words = []) => async () => ({
  text,
  meanConfidence,
  wordCount: text.split(/\s+/).filter(Boolean).length,
  words,
});

async function seed({ withCopy = true } = {}) {
  const db = openDb(':memory:');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerver-ocr-'));
  const pdf = await makePdf([BODY, 'Second page body text goes here.']);
  const { sealedBytes } = await sealPdf(db, {
    iisNo: 'R1-2026-000001', pdfBytes: pdf, keyProvider: kp,
  });
  const file = path.join(dir, 'sealed.pdf');
  await fs.writeFile(file, Buffer.from(sealedBytes));
  db.prepare('UPDATE pages SET sealed_pdf_path=? WHERE iis_no=?')
    .run(withCopy ? file : null, 'R1-2026-000001');
  return { db, dir };
}

test('a faithful reading of page 1 compares clean', async () => {
  const { db } = await seed();
  const r = await verifyPageImage(db, Buffer.alloc(1), {
    iisNo: 'R1-2026-000001', k: 1, ocr: stubOcr(BODY),
  });
  assert.equal(r.status, 'compared');
  assert.deepEqual(r.findings.filter((f) => f.severity === 'material'), []);
  assert.equal(r.iisNo, 'R1-2026-000001');
  assert.equal(r.k, 1);
});

test('an inflated amount is reported as material', async () => {
  const { db } = await seed();
  const r = await verifyPageImage(db, Buffer.alloc(1), {
    iisNo: 'R1-2026-000001', k: 1, ocr: stubOcr(BODY.replace('P50,000.00', 'P500,000.00')),
  });
  assert.ok(r.findings.some((f) => f.severity === 'material' && f.cls === 'money'));
});

test('a located finding carries a region; an unlocatable one does not', async () => {
  const { db } = await seed();
  // Real bbox/confidence values aren't needed here -- only that they flow
  // through untouched from recognize()'s shape to the final report.
  const words = 'P500,000.00 is imposed under Section 12 of the rules, and the'
    .split(' ')
    .map((text, i) => ({ text, confidence: 0.8, bbox: { x0: i * 10, y0: 0, x1: i * 10 + 8, y1: 8 } }));
  const tampered = BODY.replace('P50,000.00', 'P500,000.00');
  const r = await verifyPageImage(db, Buffer.alloc(1), {
    iisNo: 'R1-2026-000001', k: 1, ocr: stubOcr(tampered, 0.9, words),
  });
  const moneyFinding = r.findings.find((f) => f.severity === 'material' && f.cls === 'money');
  assert.ok(moneyFinding, 'expected a material money finding');
  assert.ok(moneyFinding.region, 'expected the money finding to carry a region');
  assert.equal(moneyFinding.region.x0, 0); // "P500,000.00" is the first word in the stub list above
});

test('no region on any finding when the OCR stub supplies no words', async () => {
  const { db } = await seed();
  const r = await verifyPageImage(db, Buffer.alloc(1), {
    iisNo: 'R1-2026-000001', k: 1, ocr: stubOcr(BODY.replace('P50,000.00', 'P500,000.00')),
  });
  const moneyFinding = r.findings.find((f) => f.severity === 'material' && f.cls === 'money');
  assert.ok(moneyFinding, 'expected a material money finding');
  assert.equal(moneyFinding.region, undefined);
});

test('no authoritative copy on file -> no_record_copy, not a finding', async () => {
  const { db } = await seed({ withCopy: false });
  const r = await verifyPageImage(db, Buffer.alloc(1), {
    iisNo: 'R1-2026-000001', k: 1, ocr: stubOcr(BODY),
  });
  assert.equal(r.status, 'no_record_copy');
  assert.deepEqual(r.findings, []);
});

test('an unsealed page -> no_record_copy', async () => {
  const { db } = await seed();
  const r = await verifyPageImage(db, Buffer.alloc(1), {
    iisNo: 'R1-2099-999999', k: 1, ocr: stubOcr(BODY),
  });
  assert.equal(r.status, 'no_record_copy');
});

test('a low-confidence reading is image_unreadable, not tampering', async () => {
  const { db } = await seed();
  const r = await verifyPageImage(db, Buffer.alloc(1), {
    iisNo: 'R1-2026-000001', k: 1, ocr: stubOcr(BODY, 0.1),
  });
  assert.equal(r.status, 'image_unreadable');
  assert.deepEqual(r.findings, []);
});

test('every outcome is logged, and no filesystem path leaks into the result', async () => {
  const { db } = await seed();
  const r = await verifyPageImage(db, Buffer.alloc(1), {
    iisNo: 'R1-2026-000001', k: 1, ocr: stubOcr(BODY),
  });
  assert.ok(!JSON.stringify(r).includes('sealed'), 'result leaks a path');
  const row = db.prepare('SELECT outcome, path FROM verify_log ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.outcome, 'page_image_compared');
  assert.equal(row.path, 'public');
});
