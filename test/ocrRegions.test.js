import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateFindings } from '../src/ocrRegions.js';

// bbox values are arbitrary but distinct, so a wrong pairing is easy to spot
// in a failing assertion. They do not need to correspond to a real photo.
const wordAt = (text, x0, confidence = 0.9) => ({
  text, confidence, bbox: { x0, y0: 0, x1: x0 + 10, y1: 8 },
});

test('a single-word match gets that word\'s bbox and confidence', () => {
  const words = [wordAt('Section', 0), wordAt('12', 20, 0.42)];
  const findings = [{ severity: 'material', cls: 'citation', line: 1, expected: 'Section 12', found: '12', reason: 'digit-substitution' }];
  const [f] = locateFindings(findings, words);
  assert.deepEqual(f.region, { x0: 20, y0: 0, x1: 30, y1: 8, confidence: 0.42 });
});

test('a multi-word match unions the bboxes and takes the minimum confidence', () => {
  const words = [wordAt('15', 0, 0.9), wordAt('days', 20, 0.3)];
  const findings = [{ severity: 'material', cls: 'duration', line: 1, expected: '15 days', found: '15 days', reason: 'text' }];
  const [f] = locateFindings(findings, words);
  assert.deepEqual(f.region, { x0: 0, y0: 0, x1: 30, y1: 8, confidence: 0.3 });
});

test('a finding with found: null gets no region and does not crash', () => {
  const words = [wordAt('Section', 0)];
  const findings = [{ severity: 'material', cls: 'money', line: 3, expected: '₱50,000.00', found: null, reason: 'missing' }];
  const [f] = locateFindings(findings, words);
  assert.equal(f.region, undefined);
  assert.equal(f.expected, '₱50,000.00'); // untouched
});

test('a found value with no matching run in words gets no region, and does not crash', () => {
  const words = [wordAt('Section', 0), wordAt('12', 20)];
  const findings = [{ severity: 'tolerant', cls: 'name', line: 1, expected: 'ACME CORP', found: 'totally unrelated text', reason: 'text' }];
  const result = locateFindings(findings, words);
  assert.equal(result[0].region, undefined);
  assert.equal(result.length, 1);
});

test('two findings with the same found value each get a different region', () => {
  const words = [wordAt('R1-2026-000123', 0, 0.5), wordAt('R1-2026-000123', 50, 0.8)];
  const findings = [
    { severity: 'material', cls: 'reference', line: 1, expected: null, found: 'R1-2026-000123', reason: 'added' },
    { severity: 'material', cls: 'reference', line: 2, expected: null, found: 'R1-2026-000123', reason: 'added' },
  ];
  const [f1, f2] = locateFindings(findings, words);
  assert.ok(f1.region && f2.region, 'both findings should have a region');
  assert.notEqual(f1.region.x0, f2.region.x0);
  assert.equal(f1.region.x0, 0);
  assert.equal(f2.region.x0, 50);
});

test('case and whitespace differences between found and the word text still locate correctly', () => {
  const words = [wordAt('SECTION', 0), wordAt('12', 20)];
  const findings = [{ severity: 'material', cls: 'citation', line: 1, expected: 'Section 12', found: 'section   12', reason: 'text' }];
  const [f] = locateFindings(findings, words);
  assert.ok(f.region, 'expected a region despite case/whitespace differences');
  assert.equal(f.region.x0, 0);
});

test('an empty or missing words array leaves every finding without a region', () => {
  const findings = [{ severity: 'material', cls: 'money', line: 1, expected: '₱50.00', found: '₱50.00', reason: 'text' }];
  assert.equal(locateFindings(findings, [])[0].region, undefined);
  assert.equal(locateFindings(findings, undefined)[0].region, undefined);
});

test('locateFindings does not mutate its inputs', () => {
  const words = [wordAt('12', 0)];
  const original = { severity: 'material', cls: 'citation', line: 1, expected: null, found: '12', reason: 'added' };
  const findings = [original];
  locateFindings(findings, words);
  assert.equal(original.region, undefined, 'the input finding object must not be mutated');
});

// Real case, 2026-09-09: a genuine amount change (₱350.00 -> ₱450.00) landed
// correctly as a material finding, but pageCompare.js's PESOS_PAREN fixes
// synthesize the ₱ prefix onto `found` -- it was never literally what OCR
// read (here, a single word "(450.00),", mark dropped/misread/hyphenated
// away). The exact-text search above can never match a prefix that was
// never really there, so money gets a second, narrower fallback: a single
// word whose own digits match the target's digits exactly, regardless of
// whatever punctuation/mark surrounds it.
test('a money finding whose synthesized value has no literal match still locates via matching digits', () => {
  const words = [wordAt('(450.00),', 0, 0.75)];
  const findings = [{ severity: 'material', cls: 'money', line: 39, expected: '₱350.00', found: '₱450.00', reason: 'digit-substitution' }];
  const [f] = locateFindings(findings, words);
  assert.deepEqual(f.region, { x0: 0, y0: 0, x1: 10, y1: 8, confidence: 0.75 });
});

test('the digit fallback is scoped to money only -- an unrelated class with no literal match still gets no region', () => {
  const words = [wordAt('(450.00),', 0)];
  const findings = [{ severity: 'material', cls: 'citation', line: 1, expected: 'Section 12', found: '450', reason: 'text' }];
  const [f] = locateFindings(findings, words);
  assert.equal(f.region, undefined);
});

// Guards the fallback's own edge case: an empty digit string must never
// match a non-numeric word by coincidence.
test('a money found value with no digits at all does not spuriously match via the digit fallback', () => {
  const words = [wordAt('payable', 0)];
  const findings = [{ severity: 'material', cls: 'money', line: 1, expected: '₱50.00', found: '₱', reason: 'text' }];
  const [f] = locateFindings(findings, words);
  assert.equal(f.region, undefined);
});

test('an exact literal match for a money finding is preferred over the digit fallback', () => {
  const words = [wordAt('₱450.00', 0, 0.9), wordAt('(450.00),', 50, 0.2)];
  const findings = [{ severity: 'material', cls: 'money', line: 1, expected: '₱350.00', found: '₱450.00', reason: 'digit-substitution' }];
  const [f] = locateFindings(findings, words);
  assert.equal(f.region.x0, 0); // the exact literal match, not the digit-only fallback
});

test('the digit fallback does not reuse a word another finding already consumed', () => {
  const words = [wordAt('(450.00),', 0, 0.6)];
  const findings = [
    { severity: 'material', cls: 'money', line: 1, expected: null, found: '₱450.00', reason: 'added' },
    { severity: 'material', cls: 'money', line: 2, expected: null, found: '₱450.00', reason: 'added' },
  ];
  const [f1, f2] = locateFindings(findings, words);
  assert.ok(f1.region, 'first finding should claim the word');
  assert.equal(f2.region, undefined, 'second finding should find nothing left to claim');
});
