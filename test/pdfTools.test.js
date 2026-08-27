import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { extractPageTexts, extractPageTextsWithLines } from '../src/pdfTools.js';

// Ground truth captured directly from scripts/print-test-sealed.pdf (the real
// printed-and-photographed test document used throughout this feature's
// calibration) BEFORE this refactor. extractPageTexts must keep producing
// this exact string, byte for byte -- it also feeds the sealing digest.
const PAGE1_FLAT = 'Republic of the Philippines  DEPARTMENT OF ENVIRONMENT AND NATURAL RESOURCES  ENVIRONMENTAL MANAGEMENT BUREAU — REGIONAL OFFICE NO. I  ENVIRONMENTAL COMPLIANCE CERTIFICATE  Control No. R1-2026-010734  This certifies that the proposed undertaking described below has been reviewed by the Environmental Management Bureau, Regional Office No. I, and is issued this Certificate subject to the conditions herein. Project   : Sample Aggregate Quarry and Processing Facility Proponent   : Northern Luzon Aggregates Corporation Location   : Barangay Poblacion, San Fernando City, La Union Capacity   : 120,000 metric tons per annum Classification : Category B — Environmentally Critical Area The Proponent shall implement the Environmental Management Plan submitted as part of the Initial Environmental Examination, and shall submit a Compliance Monitoring Report every six (6) months to this Office. This Certificate does not exempt the Proponent from securing other permits and clearances required by law, ordinance, or regulation.  Page 1 of 3  Government Center, Sevilla, San Fernando City, La Union 2500  EMB   ·   R1-2026-010734   ·   p1/3   ·   K1   ·   E67R-CCT7';

test('extractPageTexts is byte-for-byte unaffected by the getPageItems refactor', async () => {
  const bytes = await fs.readFile('scripts/print-test-sealed.pdf');
  const [page1] = await extractPageTexts(bytes);
  assert.equal(page1, PAGE1_FLAT);
});

test('extractPageTextsWithLines keeps real printed line breaks', async () => {
  const bytes = await fs.readFile('scripts/print-test-sealed.pdf');
  const [page1] = await extractPageTextsWithLines(bytes);
  const lines = page1.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(lines.slice(0, 5), [
    'Republic of the Philippines',
    'DEPARTMENT OF ENVIRONMENT AND NATURAL RESOURCES',
    'ENVIRONMENTAL MANAGEMENT BUREAU — REGIONAL OFFICE NO. I',
    'ENVIRONMENTAL COMPLIANCE CERTIFICATE',
    'Control No. R1-2026-010734',
  ]);
});

test('extractPageTextsWithLines returns the same number of pages as extractPageTexts', async () => {
  const bytes = await fs.readFile('scripts/print-test-sealed.pdf');
  const flat = await extractPageTexts(bytes);
  const lined = await extractPageTextsWithLines(bytes);
  assert.equal(lined.length, flat.length);
  assert.equal(lined.length, 3);
});
