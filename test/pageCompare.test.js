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

// The citation must contain NO DIGITS for this to bite. The name pattern is
// [A-Z][A-Z&.'-]+ and cannot cross the digits in 'Section 12', so that input
// never collides and the test would pass with or without masking. A Roman
// numeral IS matched by the name class, so the run spans the citation.
// Verified against a reconstruction of the discard logic: this input differs
// between the two, 'SECTION 12 ACME MINING CORP' does not.
test('a name adjacent to a digitless citation is not swallowed by it', () => {
  const t = extractTokens('Rule III ACME MINING CORP shall comply.');
  assert.deepEqual(byClass(t, 'citation'), ['Rule III']);
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

import { compare } from '../src/pageCompare.js';

const AUTH = [
  'ORDER OF THE REGIONAL DIRECTOR',
  'Issued to ACME MINING CORPORATION on 15 January 2026.',
  'A fine of ₱50,000.00 is imposed under Section 12.',
  'The respondent shall comply within 15 days of receipt.',
].join('\n');

const materials = (r) => r.findings.filter((f) => f.severity === 'material');

test('a clean reading finds nothing material', () => {
  const r = compare(AUTH, AUTH);
  assert.equal(r.status, 'compared');
  assert.deepEqual(materials(r), []);
});

test('realistic OCR noise in words alone finds nothing material', () => {
  const noisy = AUTH.replace('respondent', 'respondenl').replace('receipt', 'receipl');
  const r = compare(noisy, AUTH);
  assert.equal(r.status, 'compared');
  assert.deepEqual(materials(r), []);
});

test('an inflated amount is material, reason digit-count', () => {
  const r = compare(AUTH.replace('₱50,000.00', '₱500,000.00'), AUTH);
  const f = materials(r).find((x) => x.cls === 'money');
  assert.ok(f, 'expected a money finding');
  assert.equal(f.reason, 'digit-count');
  assert.equal(f.expected, '₱50,000.00');
  assert.equal(f.found, '₱500,000.00');
  assert.equal(f.line, 3);
});

test('a changed duration is material, reason digit-substitution', () => {
  const r = compare(AUTH.replace('15 days', '45 days'), AUTH);
  const f = materials(r).find((x) => x.cls === 'duration');
  assert.ok(f, 'expected a duration finding');
  assert.equal(f.reason, 'digit-substitution');
  assert.equal(f.expected, '15 days');
});

test('letter-for-digit OCR noise in an amount is suppressed, not reported', () => {
  const r = compare(AUTH.replace('₱50,000.00', '₱5O,OOO.OO'), AUTH);
  assert.deepEqual(materials(r), []);
});

test('an amount the record does not carry is material, reason added', () => {
  const r = compare(AUTH + '\nAn extra fee of ₱9,999.00 applies.', AUTH);
  const f = materials(r).find((x) => x.reason === 'added');
  assert.ok(f, 'expected an added-token finding');
  assert.equal(f.found, '₱9,999.00');
  assert.equal(f.expected, null);
  assert.equal(f.line, null);
});

test('an amount dropped from the photo is material, reason missing', () => {
  const r = compare(AUTH.replace('A fine of ₱50,000.00 is imposed under Section 12.', 'A fine is imposed.'), AUTH);
  const f = materials(r).find((x) => x.reason === 'missing');
  assert.ok(f, 'expected a missing-token finding');
  assert.equal(f.found, null);
});

test('a name with two character errors is tolerant, not material', () => {
  const r = compare(AUTH.replace('ACME MINING CORPORATION', 'ACME MlNING CORPORATlON'), AUTH);
  assert.deepEqual(materials(r), []);
});

test('Rule III read as Rule Ill is not a finding', () => {
  const auth = 'Issued under Rule III of the implementing rules.';
  const r = compare(auth.replace('Rule III', 'Rule Ill'), auth);
  assert.deepEqual(materials(r), []);
});

test('a wholly different page is page_differs and reports no token findings', () => {
  // Long enough to clear THRESHOLDS.minWords on its own -- the brief's original
  // one-sentence fixture (11 words) fell below minWords (20) and was caught by
  // the image_unreadable gate before the similarity check ever ran, so it never
  // actually exercised page_differs. Extended here, same "unrelated page" intent,
  // to make the test test what its name says. See task-3-report.md.
  const other = 'CERTIFICATE OF NON-COVERAGE\nThis project is not covered by the system. '
    + 'It was inspected and evaluated by the regional office, and found to require '
    + 'no permit, clearance, or further environmental review under the applicable guidelines.';
  const r = compare(other, AUTH);
  assert.equal(r.status, 'page_differs');
  assert.deepEqual(r.findings, []);
});

test('empty OCR output is image_unreadable, not a finding about the page', () => {
  for (const empty of ['', '   \n  ', 'a b']) {
    const r = compare(empty, AUTH);
    assert.equal(r.status, 'image_unreadable', JSON.stringify(empty));
    assert.deepEqual(r.findings, []);
  }
});

test('suppressed counts the differences attributed to noise', () => {
  const noisy = AUTH.replace('respondent', 'respondenl').replace('receipt', 'receipl');
  assert.ok(compare(noisy, AUTH).suppressed > 0);
});
