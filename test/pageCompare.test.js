import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWords, similarity, foldGlyphs } from '../src/pageCompare.js';

// Escapes, not literal characters, in both the fold and the tests that exercise
// it. A curly quote and an ASCII one are a pixel apart in most editors, so a
// literal cannot be reviewed by eye and does not survive being copied -- the
// first implementation of this transcribed U+2018/U+2019 as ASCII apostrophes
// and weakened this test to straight quotes, and it passed against a dead fold.
test('normalizeWords collapses whitespace and unifies punctuation variants', () => {
  const got = normalizeWords('The  \u201Cquick\u201D\n\nbrown\u2014fox \u20B11,000');
  assert.deepEqual(got, ['the', '"quick"', 'brown-fox', '₱1,000']);
});

test('normalizeWords folds the curly quotes OCR and typeset PDFs emit', () => {
  assert.deepEqual(normalizeWords('\u2018a\u2019 \u201Cb\u201D'), ["'a'", '"b"']);
});

test('normalizeWords strips the seal footer', () => {
  const got = normalizeWords('Body text. EMB · R1-2026-010734 · p3/7 · K1 · TQQ3-MTBT');
  assert.deepEqual(got, ['body', 'text.']);
});

test('similarity is 1 for identical sequences and 0 for disjoint ones', () => {
  assert.equal(similarity(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
  assert.equal(similarity(['a', 'b'], ['x', 'y']), 0);
});

test('similarity is 1 for two empty sequences', () => {
  assert.equal(similarity([], []), 1);
});

test('similarity is symmetric', () => {
  const a = normalizeWords('one two three four five');
  const b = normalizeWords('one two four five');
  assert.equal(similarity(a, b), similarity(b, a));
});

test('similarity falls below 1 whether words are dropped or invented', () => {
  const base = ['one', 'two', 'three', 'four'];
  assert.ok(similarity(base, ['one', 'two', 'three']) < 1);
  assert.ok(similarity(base, ['one', 'two', 'three', 'four', 'five']) < 1);
});

test('foldGlyphs maps letter lookalikes onto digits', () => {
  assert.equal(foldGlyphs('5O,OOO'), '50,000');
  assert.equal(foldGlyphs('l5'), '15');
  assert.equal(foldGlyphs('B2'), '82');
});

test('foldGlyphs never changes one digit into another', () => {
  assert.equal(foldGlyphs('45'), '45');
  assert.equal(foldGlyphs('500,000'), '500,000');
});

import { extractTokens } from '../src/pageCompare.js';

const byClass = (toks, cls) => toks.filter((t) => t.cls === cls).map((t) => t.value);

test('extractTokens finds money in its several written forms', () => {
  const t = extractTokens('A fine of ₱50,000.00 and PHP 1,200 and P300.50 applies.');
  assert.deepEqual(byClass(t, 'money'), ['₱50,000.00', 'PHP 1,200', 'P300.50']);
});

test('extractTokens finds numeric and worded dates', () => {
  const t = extractTokens('Issued 01/15/2026, effective 2026-01-15, signed 15 January 2026.');
  assert.deepEqual(byClass(t, 'date'), ['01/15/2026', '2026-01-15', '15 January 2026']);
});

test('extractTokens finds durations including calendar days', () => {
  const t = extractTokens('Comply within 15 days, or 3 months, or 30 calendar days.');
  assert.deepEqual(byClass(t, 'duration'), ['15 days', '3 months', '30 calendar days']);
});

test('extractTokens finds control numbers and citations', () => {
  const t = extractTokens('Per R1-2026-010734 under Section 12 and Rule III.');
  assert.deepEqual(byClass(t, 'reference'), ['R1-2026-010734']);
  assert.deepEqual(byClass(t, 'citation'), ['Section 12', 'Rule III']);
});

test('extractTokens finds runs of two or more capitalised words as names', () => {
  const t = extractTokens('Issued to ACME MINING CORPORATION by the office.');
  assert.deepEqual(byClass(t, 'name'), ['ACME MINING CORPORATION']);
});

test('extractTokens does not call a single capitalised word a name', () => {
  assert.deepEqual(byClass(extractTokens('The DENR office.'), 'name'), []);
});

test('extractTokens records the 1-based line each token sits on', () => {
  const t = extractTokens('first line\nsecond has ₱50,000.00\nthird line');
  assert.equal(t.find((x) => x.cls === 'money').line, 2);
});

test('extractTokens ignores the seal footer', () => {
  const t = extractTokens('Body. EMB · R1-2026-010734 · p3/7 · K1 · TQQ3-MTBT');
  assert.deepEqual(byClass(t, 'reference'), []);
});

test('a name adjacent to a citation is not swallowed by it', () => {
  const t = extractTokens('SECTION 12 ACME MINING CORP shall comply.');
  assert.deepEqual(byClass(t, 'citation'), ['SECTION 12']);
  assert.deepEqual(byClass(t, 'name'), ['ACME MINING CORP']);
});

test('no strict-class token is lost to an adjacent match', () => {
  const t = extractTokens('Fine ₱5,000.00 within 30 days under Section 12 per R1-2026-010734 on 2026-01-15.');
  assert.deepEqual(byClass(t, 'money'), ['₱5,000.00']);
  assert.deepEqual(byClass(t, 'duration'), ['30 days']);
  assert.deepEqual(byClass(t, 'citation'), ['Section 12']);
  assert.deepEqual(byClass(t, 'reference'), ['R1-2026-010734']);
  assert.deepEqual(byClass(t, 'date'), ['2026-01-15']);
});
