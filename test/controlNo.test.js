import test from 'node:test';
import assert from 'node:assert/strict';
import { detectControlNo } from '../src/controlNo.js';

// Only R1-YYYY-NNNNNN can be carried by the mark, so that is the only shape
// worth finding: anything else the sealer would refuse regardless.

test('finds a labelled control number and reports where it was seen', () => {
  const got = detectControlNo([
    'Control No. R1-2026-010734\nSUBJECT: Inspection',
    'Page 2 body. Control No. R1-2026-010734',
    'Page 3 approval. Control No. R1-2026-010734',
  ]);
  assert.equal(got.best, 'R1-2026-010734');
  assert.equal(got.candidates.length, 1);
  assert.deepEqual(got.candidates[0].pages, [1, 2, 3]);
  assert.equal(got.candidates[0].labelled, true);
});

test('finds an unlabelled number', () => {
  const got = detectControlNo(['Reference R1-2026-000042 issued today.']);
  assert.equal(got.best, 'R1-2026-000042');
  assert.equal(got.candidates[0].labelled, false);
});

test('reports nothing for a document with no such number', () => {
  // The real Special Order case: numbered "No. 25-506, Series of 2025".
  const got = detectControlNo([
    'SPECIAL ORDER No. 25-506  Series of 2025 SUBJECT: Designation of Inspection Team',
    'Page 2 - TEAM COMPOSITION',
  ]);
  assert.equal(got.best, null);
  assert.deepEqual(got.candidates, []);
});

test('a labelled number outranks a bare one', () => {
  // Body text citing another document must not beat the document's own number.
  const got = detectControlNo([
    'Superseding R1-2026-000001 in part. Control No. R1-2026-999888',
  ]);
  assert.equal(got.best, 'R1-2026-999888');
  assert.deepEqual(got.candidates.map((c) => c.iisNo), ['R1-2026-999888', 'R1-2026-000001']);
});

test('among equals, the one on more pages wins', () => {
  const got = detectControlNo([
    'see R1-2026-111111 and R1-2026-222222',
    'continued R1-2026-222222',
    'continued R1-2026-222222',
  ]);
  assert.equal(got.best, 'R1-2026-222222');
});

test('every distinct candidate is kept, so ambiguity stays visible', () => {
  const got = detectControlNo(['R1-2026-111111 and R1-2026-222222']);
  assert.equal(got.candidates.length, 2);
});

test('does not match a number embedded in a longer run of digits', () => {
  assert.equal(detectControlNo(['R1-2026-0107345']).best, null);
  assert.equal(detectControlNo(['XR1-2026-010734']).best, null);
});

test('tolerates how the label is written', () => {
  for (const label of ['Control No.', 'CONTROL NO:', 'Control  No', 'Control Number:']) {
    const got = detectControlNo([`${label} R1-2026-010734`]);
    assert.equal(got.candidates[0]?.labelled, true, label);
  }
});

test('the same number written twice on a page counts that page once', () => {
  const got = detectControlNo(['R1-2026-010734 ... R1-2026-010734']);
  assert.deepEqual(got.candidates[0].pages, [1]);
});

test('ignores pages that failed to extract', () => {
  const got = detectControlNo(['', null, 'Control No. R1-2026-010734', undefined]);
  assert.equal(got.best, 'R1-2026-010734');
  assert.deepEqual(got.candidates[0].pages, [3]);
});
