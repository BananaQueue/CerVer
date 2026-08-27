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

// Real case, 2026-08-24 calibration (test/fixtures/pages/1-genuine-b.jpg):
// Tesseract read the body's "Control No. R1-2026-010734" as "Rt-2026-010734"
// -- the digit right after R misread as a lookalike letter. The old pattern
// required a literal \d there, so the token wasn't just wrong, it was
// invisible to extraction entirely, and compare() reported the record's real
// reference as "missing" on an untampered page. money and citation already
// tolerate this class of noise via the DIGITISH character class at the
// extraction regex itself (see LOOSE_MONEY, CITATION_NUMERAL); reference was
// the one strict class still using bare \d.
test('extractTokens recognizes a control number even when a digit reads as a lookalike letter', () => {
  const t = extractTokens('Per Rt-2026-010734 under Section 12.');
  assert.deepEqual(byClass(t, 'reference'), ['Rt-2026-010734']);
});

// Real case, 2026-08-27: a footer stamp read "R1-2026-001024" as
// "Rl~2026-001024" -- the first hyphen misread as a tilde. Invisible to
// extraction the same way the 't' misread was, since the pattern required
// a literal hyphen at that position.
test('extractTokens recognizes a control number even when a hyphen reads as a tilde', () => {
  const t = extractTokens('Per Rl~2026-001024 under Section 12.');
  assert.deepEqual(byClass(t, 'reference'), ['Rl~2026-001024']);
});

// Real case, 2026-08-27, same footer stamp as the tilde case above but a
// different photo: "R1" misread as "Ri" (lowercase i for digit 1) AND the
// first hyphen misread as "=". Both land on REFERENCE_DIGITISH/REFERENCE_SEP.
test('extractTokens recognizes a control number even when a digit reads as a lowercase i and a hyphen reads as an equals sign', () => {
  const t = extractTokens('Per Ri=2026-001024 under Section 12.');
  assert.deepEqual(byClass(t, 'reference'), ['Ri=2026-001024']);
});

test('extractTokens finds runs of two or more capitalised words as names', () => {
  const t = extractTokens('Issued to ACME MINING CORPORATION by the office.');
  assert.deepEqual(byClass(t, 'name'), ['ACME MINING CORPORATION']);
});

test('extractTokens does not call a single capitalised word a name', () => {
  assert.deepEqual(byClass(extractTokens('The DENR office.'), 'name'), []);
});

// Real case, live-tested 2026-08-24 (the record's flattened, line-break-free
// text merged two genuinely separate printed title lines into one name
// token). As of 2026-08-25, src/verifyPageImage.js feeds the record side
// through extractPageTextsWithLines (src/pdfTools.js), which keeps real
// line breaks -- so the boundary between these two lines is now a real
// '\n', not something a word-count cap has to approximate.
test('extractTokens does not merge two adjacent printed title lines into one name', () => {
  const t = extractTokens('DEPARTMENT OF ENVIRONMENT AND NATURAL RESOURCES\nENVIRONMENTAL MANAGEMENT BUREAU');
  assert.deepEqual(byClass(t, 'name'), [
    'DEPARTMENT OF ENVIRONMENT AND NATURAL RESOURCES',
    'ENVIRONMENTAL MANAGEMENT BUREAU',
  ]);
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

test('extractTokens finds a labeled field value', () => {
  const t = extractTokens('Proponent : Northern Luzon Aggregates Corporation');
  assert.deepEqual(byClass(t, 'field'), ['Northern Luzon Aggregates Corporation']);
});

// Real case, 2026-08-25: every one of 6 genuine calibration photos
// (test/fixtures/pages/1-genuine*.jpg) read this field with a stray
// character before the colon -- Tesseract misreading the form's printed
// fill-in blank. The record's own PDF text never has this; extraction
// still has to tolerate it, since it's the photo side that matters.
test('extractTokens finds a labeled field value past a misread fill-in blank before the colon', () => {
  const t = extractTokens('Proponent _: Northern Luzon Aggregates Corporation');
  assert.deepEqual(byClass(t, 'field'), ['Northern Luzon Aggregates Corporation']);
});

test('a labeled field whose value is an ALL-CAPS run defers to the name pattern, not a corrupted field token', () => {
  const t = extractTokens('Proponent : NORTHERN LUZON AGGREGATES CORPORATION');
  assert.deepEqual(byClass(t, 'name'), ['NORTHERN LUZON AGGREGATES CORPORATION']);
  assert.deepEqual(byClass(t, 'field'), []);
});

// Real photo shapes, found 2026-08-25 across all 6 genuine calibration
// photos (test/fixtures/pages/1-genuine*.jpg): the colon itself is not a
// reliable anchor at all on this document's label lines. A first attempt
// that only widened the pre-colon character class failed real-photo
// verification -- these four are why. Anchoring on a known label instead
// (compare()'s record-driven extraction, opts.fieldLabels) fixes all four.
test('a labeled field is found even when the photo drops the colon entirely', () => {
  const t = extractTokens('Location Barangay Poblacion, San Fernando City, La Union', { fieldLabels: ['Location'] });
  assert.deepEqual(byClass(t, 'field'), ['Barangay Poblacion, San Fernando City, La Union']);
});

test('a labeled field is found even when the photo misreads the colon as "+"', () => {
  const t = extractTokens('Capacity + 120,000 metric tons per annum', { fieldLabels: ['Capacity'] });
  assert.deepEqual(byClass(t, 'field'), ['120,000 metric tons per annum']);
});

test('a labeled field is found past an em-dash-and-space before the colon', () => {
  const t = extractTokens('Proponent — : Northern Luzon Aggregates Corporation', { fieldLabels: ['Proponent'] });
  assert.deepEqual(byClass(t, 'field'), ['Northern Luzon Aggregates Corporation']);
});

test('a labeled field is found past an em-dash-then-underscore before the colon', () => {
  const t = extractTokens('Proponent —_: Northern Luzon Aggregates Corporation', { fieldLabels: ['Proponent'] });
  assert.deepEqual(byClass(t, 'field'), ['Northern Luzon Aggregates Corporation']);
});

test('a known field label must match as a whole word, not a prefix of a longer word', () => {
  const t = extractTokens('Projections are due Friday.', { fieldLabels: ['Project'] });
  assert.deepEqual(byClass(t, 'field'), []);
});

// Real case, 1-altered.jpg, 2026-08-25: OCR read stray marks before the
// label itself, not just between label and colon -- a startsWith-anchored
// search would never find this. The label can be found anywhere on the
// line, as long as both sides land on a word boundary.
test('a labeled field is found past stray marks before the label itself', () => {
  const t = extractTokens('"i Proponent —_: Northern Luzon Aggregates Corporation', { fieldLabels: ['Proponent'] });
  assert.deepEqual(byClass(t, 'field'), ['Northern Luzon Aggregates Corporation']);
});

// Real regression, found immediately after the fix above: a genuine label
// word also appears in this project's real documents as an ordinary
// grammatical subject ("The Proponent shall implement..."). Widening the
// label search to the whole line (needed for the case just above) briefly
// treated this sentence as a field line too, fabricating a phantom field
// from the rest of it. A real word (2+ letters) before the label match
// rules this out; a lone stray character does not.
test('a label word used as an ordinary grammatical subject is not treated as a field line', () => {
  const t = extractTokens('The Proponent shall implement the Environmental Management Plan submitted', { fieldLabels: ['Proponent'] });
  assert.deepEqual(byClass(t, 'field'), []);
});

// Real regression, 2026-08-27 (1-genuine.jpg, "Special Order" fixture set):
// a misread of the seal/logo glyphs bleeding into the letterhead line read
// as "NE: 5 Republic of the Philippines" -- shaped like a labeled field
// (word, colon, rest of line), but "NE" was never a real field label. The
// blind FIELD_LINE fallback used to fire anyway once the known-label loop
// found nothing on the line, fabricating a field the record never had.
test('a line shaped like a labeled field but matching no known label is not treated as one', () => {
  const t = extractTokens('NE: 5 Republic of the Philippines', { fieldLabels: ['SPECIAL ORDER NO.'] });
  assert.deepEqual(byClass(t, 'field'), []);
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

test('a page compared against a perfect reading of itself finds nothing material, even with an ALL-CAPS numbered step next to it', () => {
  // TOKEN_PATTERNS' record-side money pattern used to have no leading
  // boundary guard, so a bare "P" immediately followed by 1-3 digits read as
  // the start of an amount no matter what preceded it -- "STEP 3", "GROUP 5",
  // "CAMP 7", "TOP 10" all matched as money on the record side alone. The
  // OCR-side LOOSE_MONEY already guarded its bare-P alternative the same way
  // TOKEN_PATTERNS now does, so the two sides disagreed about what counts as
  // an amount and a page produced a material finding against its own
  // untampered self.
  const auth = 'Follow STEP 3 of the procedure. GROUP 5 and CAMP 7 report to '
    + 'TOP 10 for further instructions from the regional office as scheduled '
    + 'for this week, per the applicable guidelines currently in effect.';
  const r = compare(auth, auth);
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

test('letter-for-digit OCR noise using an uppercase-only lookalike (B for 8) is suppressed, not reported', () => {
  // GLYPH_FOLD's B->8, D->0, Q->0, S->5, Z->2, G->6 entries are uppercase-only
  // (no lowercase counterpart). keyFor used to lowercase the value before
  // folding, which silently killed these six of the map's eight letter rules
  // -- only O and l/I/| survived, because 'o' and 'l' happen to have their
  // own lowercase entries. B->b is not in the map, so it never folded back.
  const auth = AUTH.replace('₱50,000.00', '₱58,000.00');
  const r = compare(auth.replace('₱58,000.00', '₱5B,000.00'), auth);
  assert.deepEqual(materials(r), []);
});

test('letter-for-digit OCR noise in a control number is suppressed, not reported', () => {
  const auth = AUTH.replace('Section 12.', 'Section 12, per R1-2026-010734.');
  const r = compare(auth.replace('R1-2026-010734', 'Rt-2026-010734'), auth);
  assert.deepEqual(materials(r), []);
});

// Real case, 2026-08-27: extraction alone isn't enough -- keyFor's generic
// path never normalized hyphens, so even once "Rl~2026-001024" is extracted
// it would still key differently from the clean "R1-2026-001024" record
// value and report as a mismatch. This is the case a real photo actually
// produced (footer stamp), not a hypothetical.
test('a tilde-for-hyphen OCR misread in a control number is suppressed, not reported', () => {
  const auth = AUTH.replace('Section 12.', 'Section 12, per R1-2026-001024.');
  const r = compare(auth.replace('R1-2026-001024', 'Rl~2026-001024'), auth);
  assert.deepEqual(materials(r), []);
});

test('an i-for-1 and equals-for-hyphen OCR misread in a control number is suppressed, not reported', () => {
  const auth = AUTH.replace('Section 12.', 'Section 12, per R1-2026-001024.');
  const r = compare(auth.replace('R1-2026-001024', 'Ri=2026-001024'), auth);
  assert.deepEqual(materials(r), []);
});

// Real case, 2026-08-27: a footer's page indicator ("p2/2") was read as a
// phantom bare-P amount once the whole footer line leaked through
// unstripped (its reference token had failed to extract). This guard
// closes it independently of whether the reference extracts correctly.
test('a page indicator ("p2/2") is never read as a money amount', () => {
  const t = extractTokens('EMB R1-2026-001024 p2/2 K1 36DK-GKFW');
  assert.deepEqual(byClass(t, 'money'), []);
});

const FIELD_AUTH = [
  'ENVIRONMENTAL COMPLIANCE CERTIFICATE',
  'Proponent : Northern Luzon Aggregates Corporation',
  'Location : Barangay Poblacion, San Fernando City, La Union',
  'Classification : Category B — Environmentally Critical Area',
  'The Proponent shall implement the Environmental Management Plan submitted',
  'as part of the Initial Environmental Examination, and shall comply.',
].join('\n');

// Real genuine-page noise, found 2026-08-25 across the 6 committed 1-genuine*
// calibration photos (2 of 6 read this way). B->8 is already in GLYPH_FOLD;
// this proves it now actually reaches a field-class comparison (Task 1).
test('a field value differing only by a classic uppercase-glyph confusion (B for 8) is not reported at all', () => {
  const r = compare(FIELD_AUTH.replace('Category B', 'Category 8'), FIELD_AUTH);
  assert.deepEqual(r.findings, []);
});

// Real genuine-page noise, same source (1 of 6). rn->m is already one of
// foldLetterNoise's folds.
test('a field value differing only by a classic letter-run confusion (rn for m) is not reported at all', () => {
  const r = compare(FIELD_AUTH.replace('San Fernando', 'San Femando'), FIELD_AUTH);
  assert.deepEqual(r.findings, []);
});

// The real case this feature exists for: live-tested 2026-08-25, a genuine
// alteration in ordinary sentence-case text no other token class covers.
test('a pluralized field value (Corporation -> Corporations) is material', () => {
  const r = compare(FIELD_AUTH.replace('Corporation', 'Corporations'), FIELD_AUTH);
  const f = materials(r).find((x) => x.cls === 'field');
  assert.ok(f, 'expected a field finding');
  assert.equal(f.reason, 'text');
  assert.equal(f.expected, 'Northern Luzon Aggregates Corporation');
  assert.equal(f.found, 'Northern Luzon Aggregates Corporations');
});

test('a pluralized field value (Area -> Areas) is material', () => {
  const r = compare(FIELD_AUTH.replace('Critical Area', 'Critical Areas'), FIELD_AUTH);
  const f = materials(r).find((x) => x.cls === 'field');
  assert.ok(f, 'expected a field finding');
  assert.equal(f.expected, 'Category B — Environmentally Critical Area');
  assert.equal(f.found, 'Category B — Environmentally Critical Areas');
});

// Real case, live-tested 2026-08-25: a real photo carried two genuine
// alterations at once (Proponent and Classification both pluralized).
// compare()'s nearest-unclaimed-token fallback pairs a record field with
// the nearest unclaimed photo field BY LINE when an exact key match fails
// -- which both of these legitimately do, being altered. Without label
// tracking, the fallback paired Proponent's record value against
// Classification's photo value (and vice versa), reporting a scrambled,
// nonsensical mismatch instead of two clean, separate findings.
test('two field values altered on the same photo each pair with their own label, not each other', () => {
  const altered = FIELD_AUTH.replace('Corporation', 'Corporations').replace('Critical Area', 'Critical Areas');
  const r = compare(altered, FIELD_AUTH);
  const findings = materials(r).filter((x) => x.cls === 'field');
  assert.equal(findings.length, 2);
  const proponent = findings.find((f) => f.expected === 'Northern Luzon Aggregates Corporation');
  const classification = findings.find((f) => f.expected === 'Category B — Environmentally Critical Area');
  assert.ok(proponent, 'expected a Proponent finding');
  assert.ok(classification, 'expected a Classification finding');
  assert.equal(proponent.found, 'Northern Luzon Aggregates Corporations');
  assert.equal(classification.found, 'Category B — Environmentally Critical Areas');
});

// Real case, live-tested 2026-08-24: the record's flattened, line-break-free
// text carries a page's title as one unbroken run ("DEPARTMENT OF ENVIRONMENT
// AND NATURAL RESOURCES"), but the real printed page wraps that same title
// across two physical lines. Tesseract keeps real line breaks, so its reading
// splits at the wrap -- and if the trailing word lands alone on its own
// printed line, it fails the name pattern's 2-word minimum and is never
// extracted as a token at all, not even a mangled one. The photo's 5-word
// match against the record's 6-word value used to report as a tolerant
// "difference put down to the camera" even though nothing was misread --
// it's the same title, just wrapped differently than the flattened record
// text implies. One side reading a clean prefix of the other's exact value
// is that specific, known-shape artifact, not camera noise to surface.
test('a title split across a real printed line-wrap is not reported as a camera-noise difference', () => {
  const auth = AUTH.replace('ORDER OF THE REGIONAL DIRECTOR', 'DEPARTMENT OF ENVIRONMENT AND NATURAL RESOURCES');
  const ocr = auth.replace('DEPARTMENT OF ENVIRONMENT AND NATURAL RESOURCES', 'DEPARTMENT OF ENVIRONMENT AND NATURAL');
  const r = compare(ocr, auth);
  assert.deepEqual(r.findings, []);
});

test('an amount the record does not carry is material, reason added', () => {
  const r = compare(AUTH + '\nAn extra fee of ₱9,999.00 applies.', AUTH);
  const f = materials(r).find((x) => x.reason === 'added');
  assert.ok(f, 'expected an added-token finding');
  assert.equal(f.found, '₱9,999.00');
  assert.equal(f.expected, null);
  assert.equal(f.line, null);
});

test('a duplicated amount on the photo is material, not silently cleared', () => {
  // The record carries ₱50,000.00 once; the photo carries it twice. The
  // record->photo pass pairs the first occurrence and is satisfied. Without
  // consuming from authByKey by count in the photo->record pass too (it used
  // to only check presence, `.has`, never count), the second occurrence
  // matches the same key and vanishes -- an inserted duplicate fine line
  // producing zero findings.
  const r = compare(
    AUTH.replace(
      'A fine of ₱50,000.00 is imposed under Section 12.',
      'A fine of ₱50,000.00 is imposed under Section 12. A further fine of ₱50,000.00 is imposed under Section 12.'
    ),
    AUTH
  );
  const f = materials(r).find((x) => x.reason === 'added' && x.cls === 'money');
  assert.ok(f, 'expected an added-token finding for the duplicate amount');
  assert.equal(f.found, '₱50,000.00');
});

test('two independent tampered amounts each pair with their own nearby photo token', () => {
  // `near` used to take the FIRST unmatched same-class token in document
  // order, ignoring line distance, and never consumed it -- so both record
  // tokens could claim the same photo token, and the real match for the
  // second one was left over to show up as a spurious "added" finding.
  const record = [
    'A fine of ₱1,500.00 is imposed under Section 12.',
    'A further fine of ₱50,000.00 is imposed under Section 13.',
    'Additional words to clear the minimum word threshold for the OCR logic to actually run here today please.',
  ].join('\n');
  const photo = record.replace('₱1,500.00', '₱9,500.00').replace('₱50,000.00', '₱80,000.00');
  const r = compare(photo, record);
  const found = materials(r);
  assert.equal(found.length, 2, `expected exactly 2 findings, got ${JSON.stringify(found)}`);
  const line1 = found.find((f) => f.line === 1);
  const line2 = found.find((f) => f.line === 2);
  assert.ok(line1, 'expected a finding for line 1');
  assert.equal(line1.expected, '₱1,500.00');
  assert.equal(line1.found, '₱9,500.00');
  assert.ok(line2, 'expected a finding for line 2');
  assert.equal(line2.expected, '₱50,000.00');
  assert.equal(line2.found, '₱80,000.00');
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

test('digit-for-letter OCR noise inside an ordinary capitalised word does not fabricate a money finding', () => {
  // C0RP0RATI0N: every O in CORPORATION misread as 0, the common all-caps OCR
  // failure mode. The old LOOSE_MONEY pattern let "P0" inside that word match
  // as a currency amount because it never checked what came before the "P" or
  // after the digits.
  const r = compare(AUTH.replace('CORPORATION', 'C0RP0RATI0N'), AUTH);
  assert.deepEqual(materials(r), []);
});

test('a lost space before the currency mark does not truncate the amount into a phantom finding', () => {
  // OCR runs "of" straight into "₱50,000.00" with no space between them.
  // The old trailing (?![A-Za-z]) guard could not reject a match, only
  // backtrack it, but here the mark itself has no preceding-word noise to
  // strip -- the risk this guards is the pattern failing to match the mark
  // at all when it is glued to the previous word. It must still be read as
  // the full, undamaged amount.
  const r = compare(AUTH.replace('of ₱50,000.00', 'of₱50,000.00'), AUTH);
  assert.deepEqual(materials(r), []);
});

test('a lost space after a ₱ amount does not truncate it into a phantom finding', () => {
  // OCR runs "₱50,000.00" straight into "is" with no space between them.
  // ₱ can never occur mid-word, so LOOSE_MONEY's ₱/PHP alternative carries no
  // trailing guard at all and reads the full amount regardless of what
  // follows it. NOTE: this case, on its own, exercises only that alternative
  // -- it was previously the sole regression test for "a lost space after the
  // amount", and it passes identically whether the bare-P alternative's own
  // trailing-letter handling exists, is broken, or is absent, because a ₱
  // fixture never reaches that branch. See the next test for bare P, which
  // is the one this money-guard regression actually lives on.
  const r = compare(AUTH.replace('₱50,000.00 is', '₱50,000.00is'), AUTH);
  assert.deepEqual(materials(r), []);
});

test('a lost space after a bare-P amount does not truncate it into a phantom finding', () => {
  // Same defect as the ₱ case above, but on bare P -- which, unlike ₱,
  // is an ordinary letter and needs its own trailing handling. A hard "no
  // letter may follow" guard used to sit here (first a plain lookahead, then
  // an atomic (?=(x))\1 form after the plain one was found to backtrack into
  // a truncated, wrong reading). Both forms rejected the WHOLE match whenever
  // a letter followed with no space -- exactly what a lost space looks like
  // -- so "P50,000.00is" read as `missing` (atomic form) or a truncated
  // `digit-count` (plain form) instead of the full, undamaged amount: a
  // phantom material finding on a page nobody tampered with, either way.
  const auth = AUTH.replace('₱50,000.00', 'P50,000.00');
  const r = compare(auth.replace('P50,000.00 is', 'P50,000.00is'), auth);
  assert.deepEqual(materials(r), []);
});

test('a bare-P amount glued to the next word by a lost space is not confused with digit-lookalike noise inside an ordinary word (PROPONENT)', () => {
  // The trailing-letter case above must not be fixed by simply dropping the
  // guard outright -- that would let "P0" inside a misread "PROPONENT" read
  // as a phantom amount again, the exact class of false positive the guard
  // was originally added for (see the CORPORATION test below). The fix
  // distinguishes the two by structure (comma or decimal present), not by
  // "what comes after", so this must still read as nothing.
  const auth = AUTH.replace(
    'The respondent shall comply within 15 days of receipt.',
    'The respondent, on motion of the PROPONENT, shall comply within 15 days of receipt.'
  );
  const r = compare(auth.replace('PROPONENT', 'PR0P0NENT'), auth);
  assert.deepEqual(materials(r), []);
});

test('a bare-P amount glued to the next word by a lost space is not confused with digit-lookalike noise inside ordinary words (POLLUTION ADJUDICATION BOARD)', () => {
  const auth = AUTH.replace(
    'The respondent shall comply within 15 days of receipt.',
    'The respondent shall comply within 15 days of receipt, per the Pollution Adjudication Board.'
  );
  const r = compare(auth.replace('Pollution Adjudication Board', 'P0LLUTI0N ADJUDICATI0N B0ARD'), auth);
  assert.deepEqual(materials(r), []);
});

// A self-comparison property test: compare(t, t) must never produce a
// material finding, because every token extracted from a page must match
// itself. Across several rounds, the record-side money pattern (in
// TOKEN_PATTERNS) and the photo-side money pattern (extractLooseMoney) were
// fixed independently and kept drifting back out of sync -- each round
// fixed one side, verified against a handful of hand-picked cases, and left
// the other side (or a different corner of the same side) still
// disagreeing. This test is the backstop: it does not care which side is
// "right", only that record and photo agree on every token across a broad
// corpus of realistic constructions, so a future edit that touches money
// extraction on only one side fails here immediately instead of shipping a
// fifth round of the same defect class.
test('a page compared against itself finds nothing material, across a corpus of realistic money constructions', () => {
  const corpus = [
    // Already-fixed case, kept covered: ALL-CAPS numbered steps must not
    // read as bare-P money.
    'Follow STEP 3 of the procedure. GROUP 5 and CAMP 7 report to '
      + 'TOP 10 for further instructions from the regional office as scheduled '
      + 'for this week, per the applicable guidelines currently in effect.',
    // Peso shorthand: a P-prefixed amount with a unit letter and no comma or
    // decimal is ordinary Philippine-document usage, not tamper evidence.
    'The fee is P1M for the year and must be paid in full by the applicant '
      + 'before the deadline set forth in this order today.',
    'The fee is P50k for now and remains subject to change pending further '
      + 'review by the regional office in the coming weeks ahead.',
    'The penalty is P100B for violators who fail to comply with the '
      + 'applicable environmental regulations within the prescribed period of time.',
    // Not money at all -- an ordinary abbreviation that happens to start
    // with a bare P immediately followed by digits.
    'A P2P transfer was recorded in the ledger during the audit conducted '
      + 'by the finance office last month without any incident reported.',
    // A unit letter glued onto a genuine-looking amount, same shape as OCR
    // noise but present verbatim in the source text.
    'Item P12B of the schedule refers to a separate annex that lists '
      + 'additional requirements for the applicant to fulfill before approval.',
    // A PHP-prefixed amount with its trailing space already lost -- the
    // Critical-A repro, self-compared instead of record-vs-photo.
    'A fine of PHP 500was imposed on the respondent hereof for violating '
      + 'the terms and conditions set forth in this order today.',
    // Round-4 additions. Self-comparison cannot see the record/photo
    // asymmetries these constructions used to cause (there is one definition
    // now, so both sides drift together) -- they are here as the backstop
    // against a FUTURE edit that reintroduces a split. The asymmetries
    // themselves are tested record-vs-photo, below this test.
    //
    // An amount written with no thousands separator at all.
    'A fine of ₱50000.00 is imposed on the respondent hereof for violating '
      + 'the terms and conditions set forth in this order today.',
    // The same amount with the separator read as a period rather than a comma.
    'A fine of ₱50.000.00 is imposed on the respondent hereof for violating '
      + 'the terms and conditions set forth in this order today.',
    // A bare-P amount under 1,000 with no decimal, glued to the next word.
    'The fee is P500due now and must be settled by the applicant before the '
      + 'deadline set forth in this order today without any further delay.',
    // Php -- the conventional Philippine mixed-case spelling of the currency.
    'A fine of Php 50,000.00 is imposed on the respondent hereof for violating '
      + 'the terms and conditions set forth in this order today.',
    // An ordinary word beginning with P whose second letter OCR read as a
    // digit. "P1" here is noise inside a word, not an amount.
    'The P1PELINE crossing the easement shall be inspected by the regional '
      + 'office within the period prescribed under the applicable guidelines.',
  ];
  for (const t of corpus) {
    const r = compare(t, t);
    assert.deepEqual(materials(r), [], `expected no material findings for: ${t}`);
  }
});

// ---- Round 4: the record-vs-photo asymmetries the corpus above cannot see ----
//
// Filler so every fixture below clears THRESHOLDS.minWords (20) on its own;
// short fixtures return image_unreadable with an empty findings array and
// assert nothing, which has already happened twice in this file.
const PAD = 'The respondent shall comply with the terms and conditions set forth in '
  + 'this order issued by the regional office today without any further delay.';

// Design spec 5.4 requires thousands separators be normalised on BOTH sides.
// They were not: AMOUNT required digits in groups of exactly three separated
// by commas, so a comma-less run was truncated to its first three digits and
// the truncation was then reported as `digit-count` -- the most alarming label
// the feature has -- on a page nobody touched. A dropped or misread comma is
// one of the commonest photo errors on a printed amount.
test('a comma dropped by OCR from an amount is not a finding', () => {
  const auth = 'A fine of ₱50,000.00 is imposed. ' + PAD;
  const r = compare(auth.replace('₱50,000.00', '₱50000.00'), auth);
  assert.deepEqual(materials(r), []);
});

test("a thousands comma read as a period is not a finding", () => {
  const auth = 'A fine of ₱50,000.00 is imposed. ' + PAD;
  const r = compare(auth.replace('₱50,000.00', '₱50.000.00'), auth);
  assert.deepEqual(materials(r), []);
});

test('a comma dropped from a PHP-marked amount is not a finding', () => {
  const auth = 'A fine of PHP 1,200.00 is imposed. ' + PAD;
  const r = compare(auth.replace('PHP 1,200.00', 'PHP 1200.00'), auth);
  assert.deepEqual(materials(r), []);
});

// The other half of the same defect: truncating at three digits also HID a
// tampered digit sitting past that point, so an ungrouped amount could be
// edited invisibly. Widening the pattern must not buy the false positive back
// at the cost of this.
test('a tampered digit past the third position of an ungrouped amount is still material', () => {
  const auth = 'A fine of ₱10000 is imposed. ' + PAD;
  const r = compare(auth.replace('₱10000', '₱10009'), auth);
  const f = materials(r).find((x) => x.cls === 'money');
  assert.ok(f, 'expected a money finding');
  assert.equal(f.reason, 'digit-substitution');
  assert.equal(f.expected, '₱10000');
  assert.equal(f.found, '₱10009');
});

// The glued-match filter used to ask "does the match contain a comma or a
// decimal point". A real amount under 1,000 with no centavos has neither, and
// fees and small fines are routinely written that way -- so a lost space next
// to one was discarded on whichever side lost the space and reported as a
// missing (or added) amount. Both directions, because the old filter was
// asymmetric and a one-directional test would have passed against it.
test('a bare-P amount under 1,000 with no decimal, glued to the next word, is not a finding', () => {
  const auth = 'The fee is P500 due now. ' + PAD;
  const r = compare(auth.replace('P500 due', 'P500due'), auth);
  assert.deepEqual(materials(r), []);
});

test('the same glued bare-P amount is not a finding when the RECORD is the glued side', () => {
  const auth = 'The fee is P250due now. ' + PAD;
  const r = compare(auth.replace('P250due', 'P250 due'), auth);
  assert.deepEqual(materials(r), []);
});

// Php is the conventional Philippine spelling. date, duration and citation all
// carry the `i` flag; money did not, so a Php-marked amount was not extracted
// as a token AT ALL, on either side -- a tampered amount on such a page could
// never be flagged, because there was nothing to compare.
test('a tampered Php (mixed-case) amount is material', () => {
  const auth = 'A fine of Php 50,000.00 is imposed. ' + PAD;
  const r = compare(auth.replace('Php 50,000.00', 'Php 90,000.00'), auth);
  const f = materials(r).find((x) => x.cls === 'money');
  assert.ok(f, 'expected a money finding');
  assert.equal(f.expected, 'Php 50,000.00');
  assert.equal(f.found, 'Php 90,000.00');
  assert.equal(f.reason, 'digit-substitution');
});

test('extractTokens finds a Php-marked amount, whatever the case of the mark', () => {
  const t = extractTokens('Fines of Php 1,200.00 and php 300.50 and PHP 40.00 apply.');
  assert.deepEqual(byClass(t, 'money'), ['Php 1,200.00', 'php 300.50', 'PHP 40.00']);
});

// The leading-real-digit anchor exists to stop bare P + a lookalike letter
// (CORPORATION) reading as money. ₱ and PHP cannot occur mid-word, so the
// anchor bought them nothing and cost them spec 5.4's letter-for-digit
// forgiveness at the FIRST digit position only -- every other position in the
// same amount was already forgiven.
test('letter-for-digit noise at the first digit after a peso mark is forgiven', () => {
  const auth = 'A fine of ₱500.00 is imposed. ' + PAD;
  const r = compare(auth.replace('₱500.00', '₱S00.00'), auth);
  assert.deepEqual(materials(r), []);
});

test('letter-for-digit noise at the first digit after a PHP mark is forgiven', () => {
  const auth = 'A fine of PHP 500.00 is imposed. ' + PAD;
  const r = compare(auth.replace('PHP 500.00', 'PHP S00.00'), auth);
  assert.deepEqual(materials(r), []);
});

// ...but the bare-P branch must KEEP its anchor: that is the only thing
// separating a real amount from an ordinary word beginning with P.
test('a bare P followed by a lookalike letter is still not an amount', () => {
  const auth = 'Issued to the PORT AUTHORITY of the region. ' + PAD;
  const r = compare(auth.replace('PORT', 'P0RT'), auth);
  assert.deepEqual(materials(r), []);
});

// Widening the glued-match filter must not let noise inside an ordinary word
// through. "P1PELINE" (PIPELINE with the I misread as a 1) is the shape that
// a naive "the run is all real digits" test would wrongly admit.
test('a digit misread inside a word beginning with P does not fabricate an amount', () => {
  const auth = 'The PIPELINE crossing the easement shall be inspected. ' + PAD;
  const r = compare(auth.replace('PIPELINE', 'P1PELINE'), auth);
  assert.deepEqual(materials(r), []);
});

test('Rule III read as Rule Ill is not a finding', () => {
  // Padded past THRESHOLDS.minWords (20): the original 8-word fixture fell
  // below the gate, so compare() returned image_unreadable with an empty
  // findings array before the citation logic ever ran, and the assertion
  // passed without exercising it. See task-3-fix-report.md.
  const auth = 'Issued under Rule III of the implementing rules, per the applicable '
    + 'regional office guidelines and procedures currently in full effect for this case.';
  const r = compare(auth.replace('Rule III', 'Rule Ill'), auth);
  assert.deepEqual(materials(r), []);
});

// Design spec 5.4: letter-for-digit OCR confusion is forgiven everywhere,
// including citations. Before the fix, the citation pattern's numeral was
// (?:[IVXLC]+|\d+) -- an all-Roman or all-digit run, nothing mixed -- so a
// mixed OCR reading was not extracted as a citation token at all, and the
// record's "Section 12" reported as missing: a material false positive on a
// genuine page. These three inputs are the exact failure cases from the task.
test('Section 12 read as Section 1Z (digit + lookalike) is not a finding', () => {
  const r = compare(AUTH.replace('Section 12', 'Section 1Z'), AUTH);
  assert.deepEqual(materials(r), []);
});

test('Section 12 read as Section l2 (lookalike + digit) is not a finding', () => {
  const r = compare(AUTH.replace('Section 12', 'Section l2'), AUTH);
  assert.deepEqual(materials(r), []);
});

test('Rule III read as Rule ||| (lookalike-only) is not a finding', () => {
  // Padded past THRESHOLDS.minWords for the same reason as the Ill test above.
  const auth = 'Issued under Rule III of the implementing rules, per the applicable '
    + 'regional office guidelines and procedures currently in full effect for this case.';
  const r = compare(auth.replace('Rule III', 'Rule |||'), auth);
  assert.deepEqual(materials(r), []);
});

// Governing rule: widening the tokenizer must not weaken digit-count or
// digit-substitution -- those stay material even though the fold now runs.
test('Section 12 vs Section 13 is material, reason digit-substitution', () => {
  const r = compare(AUTH.replace('Section 12', 'Section 13'), AUTH);
  const f = materials(r).find((x) => x.cls === 'citation');
  assert.ok(f, 'expected a citation finding');
  assert.equal(f.reason, 'digit-substitution');
  assert.equal(f.expected, 'Section 12');
  assert.equal(f.found, 'Section 13');
});

test('Section 12 vs Section 120 is material, reason digit-count', () => {
  const r = compare(AUTH.replace('Section 12', 'Section 120'), AUTH);
  const f = materials(r).find((x) => x.cls === 'citation');
  assert.ok(f, 'expected a citation finding');
  assert.equal(f.reason, 'digit-count');
  assert.equal(f.expected, 'Section 12');
  assert.equal(f.found, 'Section 120');
});

// Genuinely different Roman-numeral citations must still be caught -- the
// widened numeral must not blur distinct citations together.
test('Rule IV vs Rule VI is still material', () => {
  const auth = 'Issued under Rule IV of the implementing rules, per the applicable '
    + 'regional office guidelines and procedures currently in full effect for this case.';
  const r = compare(auth.replace('Rule IV', 'Rule VI'), auth);
  const f = materials(r).find((x) => x.cls === 'citation');
  assert.ok(f, 'expected a citation finding');
  assert.equal(f.expected, 'Rule IV');
  assert.equal(f.found, 'Rule VI');
});

test('Rule IX vs Rule XI is still material', () => {
  const auth = 'Issued under Rule IX of the implementing rules, per the applicable '
    + 'regional office guidelines and procedures currently in full effect for this case.';
  const r = compare(auth.replace('Rule IX', 'Rule XI'), auth);
  const f = materials(r).find((x) => x.cls === 'citation');
  assert.ok(f, 'expected a citation finding');
  assert.equal(f.expected, 'Rule IX');
  assert.equal(f.found, 'Rule XI');
});

test('Section XII vs Section XIII is still material', () => {
  const auth = 'Issued under Section XII of the implementing rules, per the applicable '
    + 'regional office guidelines and procedures currently in full effect for this case.';
  const r = compare(auth.replace('Section XII', 'Section XIII'), auth);
  const f = materials(r).find((x) => x.cls === 'citation');
  assert.ok(f, 'expected a citation finding');
  assert.equal(f.expected, 'Section XII');
  assert.equal(f.found, 'Section XIII');
});

// False-positive sweep: a keyword followed by an ordinary capitalised word
// (not a numeral) must not become a phantom citation just because every
// letter in the word happens to be a digit lookalike.
test('citation numeral widening does not fabricate citations from ordinary capitalised words', () => {
  const t = extractTokens(
    'Section OF THE ORDER shall apply. Rule OB was not followed. '
    + 'Article SB governs this matter. Sec. GO to the office immediately please.'
  );
  assert.deepEqual(byClass(t, 'citation'), []);
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

// ---- Round 5 findings ----
//
// Finding 1 (Critical): the thousands separator was widened to accept both
// ',' and '.' because OCR confuses them, but CENTAVOS -- the two-digit cents
// group -- accepted only '.'. A comma-for-decimal misread ("₱50,000,00" for
// "₱50,000.00") truncated the match at the thousands group and reported the
// loudest label the feature has (digit-count) on an untampered page. The
// reverse confusion (period read as comma) was already forgiven for the
// thousands group; only the centavos direction was not.
test('a comma read for the decimal point (centavos) in an amount is forgiven, not a finding', () => {
  const cases = [
    ['₱50,000.00', '₱50,000,00'],
    ['P500.00', 'P500,00'],
    ['P1,250.75', 'P1,250,75'],
  ];
  for (const [clean, commaDecimal] of cases) {
    const auth = `A fine of ${clean} is imposed. ${PAD}`;
    const r = compare(auth.replace(clean, commaDecimal), auth);
    assert.deepEqual(materials(r), [], `expected no material findings for ${commaDecimal}`);
  }
});

// Finding 2 (Critical): the leading character after the currency mark was
// loosened to a digit-lookalike class so "₱S00.00" is forgiven, but the
// amount pattern also allows a zero-length remainder after that one
// character -- so the mark plus a SINGLE letter, with no real digit
// anywhere in the match, was itself accepted as a complete "amount". Because
// money extraction runs first and masks its matched span before citation and
// date extraction run, this phantom token ate the first letter of the
// following real word and hid a genuinely tampered citation or date
// completely -- a false negative on the exact tamper this feature exists to
// catch.
test('a phantom PHP-plus-letter token does not swallow a tampered citation behind it', () => {
  const auth = `Penalty applies under PHP Section 12 of the Rules. ${PAD}`;
  const tampered = auth.replace('PHP Section 12', 'PHP Section 13');
  const r = compare(tampered, auth);
  const f = materials(r).find((x) => x.cls === 'citation');
  assert.ok(f, `expected a citation finding, got ${JSON.stringify(materials(r))}`);
  assert.equal(f.expected, 'Section 12');
  assert.equal(f.found, 'Section 13');
});

test('a phantom PHP-plus-letter token does not swallow a tampered date behind it', () => {
  const auth = `Dated PHP October 3, 2026 as filed with the office. ${PAD}`;
  const tampered = auth.replace('PHP October 3, 2026', 'PHP October 9, 2026');
  const r = compare(tampered, auth);
  const f = materials(r).find((x) => x.cls === 'date');
  assert.ok(f, `expected a date finding, got ${JSON.stringify(materials(r))}`);
  assert.equal(f.expected, 'October 3, 2026');
  assert.equal(f.found, 'October 9, 2026');
});

// Finding (Round 6): hasRealDigit rejected the phantom "PHP S" token above by
// requiring a genuine 0-9 somewhere in the match, but an amount whose digits
// are ALL glyph lookalikes -- "1" read as "l", every "0" read as "O" -- has no
// real digit either, and was over-rejected right along with the phantom. That
// amount vanished from extraction entirely instead of being forgiven, so an
// untampered page reported a material "missing" money finding: a false
// positive on the exact ship criterion this feature is gated on.
test('an amount with every digit misread as a lookalike letter is forgiven, not a finding', () => {
  const auth = `A fine of ₱1,000.00 is imposed. ${PAD}`;
  const allLookalike = auth.replace('₱1,000.00', '₱l,OOO.OO');
  const r = compare(allLookalike, auth);
  assert.deepEqual(materials(r), [], `expected no material findings, got ${JSON.stringify(materials(r))}`);
});
