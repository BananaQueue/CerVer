# Page Image OCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let someone attach a photo of a printed, seal-verified page and be told which amounts, dates and durations on it disagree with the authoritative record.

**Architecture:** Three modules split along the deterministic/nondeterministic line. `src/pageCompare.js` is a pure function holding every judgment (normalization, similarity, token rules) and is unit-tested with fixed strings — no OCR engine ever runs in `npm test`. `src/ocr.js` wraps tesseract.js and holds all the flakiness. `src/verifyPageImage.js` orchestrates: pull the authoritative page text out of the sealed PDF on file, run both, log the outcome.

**Tech Stack:** Node ESM, `node:test`, `node:sqlite`, Fastify 5, `@fastify/multipart`, `pdfjs-dist` (via existing `src/pdfTools.js`), `tesseract.js` (new).

**Spec:** [`docs/superpowers/specs/2026-08-13-page-image-ocr-design.md`](../specs/2026-08-13-page-image-ocr-design.md)

## Global Constraints

- **This is evidence, not proof** (spec §2). A clean comparison is reported as **"nothing found"** — never "verified", "authentic", or a green stamp. Green (`var(--ok)`) is reserved for the seal. Comparison never gates, overrides, or downgrades a seal result.
- **One report for every caller** (spec §6). No `staff` parameter, no per-caller field withholding. The `staff=1` flag is being deleted from this codebase; do not reintroduce it.
- **Digit rules are inviolable** (spec §5.4): digit-count differences and digit↔digit substitutions are **always material**. Only letter↔digit glyph confusions are forgiven.
- **ESM only** — `import`/`export`, matching every file in `src/`.
- **No new runtime dependency except `tesseract.js`.** `pageCompare.js` imports nothing.
- **Tests are `node:test` + `node:assert/strict`**, run by `npm test` (`node --test`). Every test added by this plan must run offline and without an OCR engine, except Task 8's, which is opt-in.
- **Uploaded images are never written to disk or stored in the DB.**
- **Prettier-ish house style:** 2-space indent, single quotes, semicolons, ~100 col.

---

### Task 1: Normalization and Tier 1 similarity

The foundation of `pageCompare`: turn two texts into comparable word sequences, and score how alike they are. Pure, no dependencies.

**Files:**
- Create: `src/pageCompare.js`
- Create: `test/pageCompare.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeWords(text: string) => string[]`
  - `similarity(a: string[], b: string[]) => number` — 0..1, symmetric
  - `foldGlyphs(token: string) => string` — letter→digit fold, used by later tasks

- [ ] **Step 1: Write the failing test**

Create `test/pageCompare.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWords, similarity, foldGlyphs } from '../src/pageCompare.js';

test('normalizeWords collapses whitespace and unifies punctuation variants', () => {
  const got = normalizeWords('The  “quick”\n\nbrown—fox ₱1,000');
  assert.deepEqual(got, ['the', '"quick"', 'brown-fox', '₱1,000']);
});

test('normalizeWords strips the seal footer', () => {
  const got = normalizeWords('Body text. EMB · R1-2026-010734 · p3/7 · K1 · TQQ3-MTBT');
  assert.deepEqual(got, ['body', 'text.']);
});

test('similarity is 1 for identical sequences and 0 for disjoint ones', () => {
  assert.equal(similarity(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
  assert.equal(similarity(['a', 'b'], ['x', 'y']), 0);
});

test('similarity is symmetric', () => {
  const a = normalizeWords('one two three four five');
  const b = normalizeWords('one two four five');
  assert.equal(similarity(a, b), similarity(b, a));
});

test('similarity penalises invented words as much as dropped ones', () => {
  const base = ['one', 'two', 'three', 'four'];
  const dropped = ['one', 'two', 'three'];
  const invented = ['one', 'two', 'three', 'four', 'five'];
  assert.equal(similarity(base, dropped), similarity(base, invented));
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test test/pageCompare.test.js
```

Expected: FAIL — `Cannot find module '.../src/pageCompare.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/pageCompare.js`:

```js
// Compare OCR text from a photographed page against the authoritative page text.
//
// Pure — no I/O, no OCR engine, no PDF, no DB. Every judgment about what counts
// as a difference lives here, which is what makes it testable without
// photographing anything. See docs/superpowers/specs/2026-08-13-page-image-ocr-design.md
//
// This produces EVIDENCE, not proof. A clean result means "nothing found", not
// "verified" — only the seal verifies anything.

import { stripFooter } from './sealCode.js';

// Letter shapes OCR returns in place of digits. Folded toward the digit because
// no forger substitutes O for 0 — that is unambiguously the camera. Digit->digit
// is deliberately absent: we cannot tell "OCR misread 1 as 4" from "someone
// changed 1 to 4", so we never forgive it.
const GLYPH_FOLD = new Map([
  ['O', '0'], ['o', '0'], ['Q', '0'], ['D', '0'],
  ['l', '1'], ['I', '1'], ['|', '1'],
  ['S', '5'], ['B', '8'], ['Z', '2'], ['G', '6'],
]);

export function foldGlyphs(token) {
  return String(token ?? '')
    .split('')
    .map((ch) => GLYPH_FOLD.get(ch) ?? ch)
    .join('');
}

const PUNCT_FOLD = [
  [/[‘’‛]/g, "'"],
  [/[“”‟]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/ /g, ' '],
];

// Lower-cased whitespace-separated words, footer removed. Case is folded because
// tamper detection does not turn on it and OCR case errors are common.
export function normalizeWords(text) {
  let s = stripFooter(String(text ?? ''));
  for (const [re, to] of PUNCT_FOLD) s = s.replace(re, to);
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

// Length of the longest common subsequence, Hirschberg-free: we only need the
// length, so two rolling rows are enough and memory stays O(min(n,m)).
function lcsLength(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let prev = new Array(short.length + 1).fill(0);
  let cur = new Array(short.length + 1).fill(0);
  for (let i = 1; i <= long.length; i++) {
    for (let j = 1; j <= short.length; j++) {
      cur[j] = long[i - 1] === short[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[short.length];
}

// 2*LCS / (|a| + |b|) — symmetric, so a photo that drops words and one that
// invents them are penalised alike.
export function similarity(a, b) {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * lcsLength(a, b)) / total;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test test/pageCompare.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Run the whole suite to confirm nothing else broke**

```bash
npm test
```

Expected: no new failures versus the pre-task baseline.

- [ ] **Step 6: Commit**

```bash
git add src/pageCompare.js test/pageCompare.test.js
git commit -m "feat(compare): normalize page text and score how alike two readings are"
```

---

### Task 2: High-value token extraction

Pull out the things worth checking exactly — amounts, dates, durations, references, citations, names — with the line each sits on, so a finding can point at a place on the sheet.

**Files:**
- Modify: `src/pageCompare.js`
- Modify: `test/pageCompare.test.js`

**Interfaces:**
- Consumes: `foldGlyphs` (Task 1).
- Produces: `extractTokens(text: string) => Array<{ cls, value, line }>` where `cls` is one of `'money' | 'date' | 'duration' | 'reference' | 'citation' | 'name'`, `value` is the raw matched text, and `line` is the 1-based line number in the input.

- [ ] **Step 1: Write the failing test**

Append to `test/pageCompare.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test test/pageCompare.test.js
```

Expected: FAIL — `extractTokens is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/pageCompare.js`:

```js
const MONTH = 'January|February|March|April|May|June|July|August|September|October|November|December';

// Order matters: the first pattern to claim a span wins, so the more specific
// classes are listed before the looser ones. `name` is last because a run of
// capitals would otherwise swallow "Section 12" style citations.
const TOKEN_PATTERNS = [
  ['money', new RegExp(String.raw`(?:₱|PHP|P)\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?`, 'g')],
  ['date', new RegExp(String.raw`\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b|\b\d{1,2}\s+(?:${MONTH})\s+\d{4}\b|\b(?:${MONTH})\s+\d{1,2},\s*\d{4}\b`, 'gi')],
  ['duration', new RegExp(String.raw`\b\d+\s+(?:calendar\s+)?(?:day|days|month|months|year|years|week|weeks)\b`, 'gi')],
  ['reference', new RegExp(String.raw`\bR\d-\d{4}-\d{6}\b|\bNo\.\s?\d{2}-\d{3,6}\b`, 'g')],
  ['citation', new RegExp(String.raw`\b(?:Section|Sec\.|Rule|Article|Art\.)\s+(?:[IVXLC]+|\d+)\b`, 'gi')],
  ['name', new RegExp(String.raw`\b[A-Z][A-Z&.'-]+(?:\s+[A-Z][A-Z&.'-]+)+\b`, 'g')],
];

// Tokens the record carries that must survive in the photo, each tied to the
// line it sits on so a finding can point somewhere on the sheet.
export function extractTokens(text) {
  // stripFooter canonicalizes whitespace, which would destroy line structure —
  // so split first and strip the footer per line, keeping line numbers intact.
  const rawLines = String(text ?? '').split('\n');
  const out = [];
  const claimed = rawLines.map(() => []);

  const overlaps = (spans, start, end) => spans.some(([s, e]) => start < e && end > s);

  for (const [cls, re] of TOKEN_PATTERNS) {
    rawLines.forEach((raw, i) => {
      const line = stripFooter(raw);
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (overlaps(claimed[i], start, end)) continue;
        claimed[i].push([start, end]);
        out.push({ cls, value: m[0], line: i + 1 });
      }
    });
  }
  return out.sort((a, b) => a.line - b.line);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test test/pageCompare.test.js
```

Expected: PASS, 15 tests.

If `extractTokens ignores the seal footer` fails, the footer is spanning a line boundary in the fixture — `stripFooter` is applied per raw line here, so keep footer text on one line in tests, matching how it is stamped.

- [ ] **Step 5: Commit**

```bash
git add src/pageCompare.js test/pageCompare.test.js
git commit -m "feat(compare): pull the values worth checking exactly out of page text"
```

---

### Task 3: The comparison itself

Match extracted tokens both ways, classify each difference as material or noise under the digit rules, and assemble the report.

**Files:**
- Modify: `src/pageCompare.js`
- Modify: `test/pageCompare.test.js`

**Interfaces:**
- Consumes: `normalizeWords`, `similarity`, `foldGlyphs`, `extractTokens`.
- Produces:
  - `compare(ocrText: string, authText: string) => Report`
  - `THRESHOLDS: { samePageMin: number, minWords: number }` — **provisional, uncalibrated**; Task 8 replaces the values.

`Report` shape, exactly as spec §5.5:

```js
{
  status: 'compared' | 'page_differs' | 'image_unreadable',
  similarity: number,
  findings: Array<{
    severity: 'material' | 'tolerant',
    cls: 'money'|'date'|'duration'|'reference'|'citation'|'name',
    line: number | null,
    expected: string | null,
    found: string | null,
    reason: 'digit-count' | 'digit-substitution' | 'missing' | 'added' | 'text',
  }>,
  suppressed: number,
}
```

- [ ] **Step 1: Write the failing test**

Append to `test/pageCompare.test.js`:

```js
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
  const other = 'CERTIFICATE OF NON-COVERAGE\nThis project is not covered by the system.';
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test test/pageCompare.test.js
```

Expected: FAIL — `compare is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/pageCompare.js`:

```js
// PROVISIONAL — not yet calibrated against real photographs. Spec §9.2 requires
// these be measured on photographs of real printed pages before the feature is
// announced to staff; renders of the PDF are not admissible evidence for them.
// See docs/superpowers/plans/2026-08-13-page-image-ocr.md Task 8.
export const THRESHOLDS = {
  samePageMin: 0.6, // below this, the photo is not this page at all
  minWords: 20, // below this, OCR did not read enough to say anything
};

const STRICT = new Set(['money', 'date', 'duration', 'reference', 'citation']);

// Roman numerals in citations come back with the classic I/l/1 confusion, and
// without this fold every document citing a rule carries a standing false
// positive. Digits are untouched — a Roman numeral has none.
const ROMAN_FOLD = (s) => s.replace(/[l1|]/g, 'I').replace(/v/g, 'V');

function keyFor(cls, value) {
  const base = value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (cls === 'citation') return ROMAN_FOLD(base.toUpperCase()).toLowerCase();
  if (cls === 'name') return foldNameNoise(base);
  return foldGlyphs(base).replace(/^(?:php|p)\s?/, '₱');
}

// Tolerant classes: fold the confusions that dominate OCR of long words, so a
// name is only reported when it differs by more than the camera plausibly does.
function foldNameNoise(s) {
  return foldGlyphs(s).replace(/rn/g, 'm').replace(/cl/g, 'd').replace(/vv/g, 'w');
}

function digitsOf(s) {
  return (s.match(/\d/g) || []).join('');
}

// Why a strict token differs. Digit-count and digit-for-digit are ALWAYS
// material: we cannot distinguish a misread from an edit, and the two are not
// equally costly when wrong.
function reasonFor(expected, found) {
  const de = digitsOf(foldGlyphs(expected));
  const df = digitsOf(foldGlyphs(found));
  if (de.length !== df.length) return 'digit-count';
  if (de !== df) return 'digit-substitution';
  return 'text';
}

function indexByKey(tokens) {
  const m = new Map();
  for (const t of tokens) {
    const key = keyFor(t.cls, t.value);
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(t);
  }
  return m;
}

export function compare(ocrText, authText) {
  const ocrWords = normalizeWords(ocrText);
  const authWords = normalizeWords(authText);

  if (ocrWords.length < THRESHOLDS.minWords) {
    return { status: 'image_unreadable', similarity: 0, findings: [], suppressed: 0 };
  }

  const sim = similarity(ocrWords, authWords);
  if (sim < THRESHOLDS.samePageMin) {
    return { status: 'page_differs', similarity: sim, findings: [], suppressed: 0 };
  }

  const authTokens = extractTokens(authText);
  const ocrTokens = extractTokens(ocrText);
  const ocrByKey = indexByKey(ocrTokens);
  const authByKey = indexByKey(authTokens);

  const findings = [];
  let suppressed = 0;

  // Record -> photo. Did every value survive?
  for (const t of authTokens) {
    const key = keyFor(t.cls, t.value);
    const hit = ocrByKey.get(key);
    if (hit && hit.length) {
      hit.shift(); // consume, so duplicates pair up one-for-one
      continue;
    }
    const strict = STRICT.has(t.cls);
    // Nearest same-class token on the photo, to report WHAT it reads instead.
    const near = ocrTokens.find((o) => o.cls === t.cls && !authByKey.has(keyFor(o.cls, o.value)));
    if (!strict) {
      suppressed++;
      findings.push({
        severity: 'tolerant', cls: t.cls, line: t.line,
        expected: t.value, found: near ? near.value : null, reason: 'text',
      });
      continue;
    }
    findings.push({
      severity: 'material', cls: t.cls, line: t.line,
      expected: t.value,
      found: near ? near.value : null,
      reason: near ? reasonFor(t.value, near.value) : 'missing',
    });
  }

  // Photo -> record. Did the photo gain a value the record never had?
  for (const o of ocrTokens) {
    if (!STRICT.has(o.cls)) continue;
    const key = keyFor(o.cls, o.value);
    if (authByKey.has(key)) continue;
    if (findings.some((f) => f.found === o.value)) continue; // already paired above
    findings.push({
      severity: 'material', cls: o.cls, line: null,
      expected: null, found: o.value, reason: 'added',
    });
  }

  // Word-level differences not accounted for by any token finding are the
  // ordinary noise of reading paper. Counted, shown, not itemised as findings.
  const wordDiff = Math.max(authWords.length, ocrWords.length) - lcsLength(ocrWords, authWords);
  suppressed += Math.max(0, wordDiff - findings.length);

  const order = { material: 0, tolerant: 1 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || (a.line ?? 1e9) - (b.line ?? 1e9));

  return { status: 'compared', similarity: sim, findings, suppressed };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test test/pageCompare.test.js
```

Expected: PASS, 27 tests.

The likely failure is `a name with two character errors is tolerant, not material` — if `ACME MlNING CORPORATlON` still reports, check that `foldNameNoise` runs `foldGlyphs` (which maps `l`→`1`) on **both** sides, so both fold to the same key.

- [ ] **Step 5: Run the whole suite**

```bash
npm test
```

Expected: no new failures.

- [ ] **Step 6: Commit**

```bash
git add src/pageCompare.js test/pageCompare.test.js
git commit -m "feat(compare): report the values that changed, suppress what the camera did"
```

---

### Task 4: OCR engine wrapper and vendored language data

Everything nondeterministic, behind one function. Includes installing the dependency and committing the language data so verification never needs the internet.

**Files:**
- Create: `src/ocr.js`
- Create: `vendor/tesseract/README.md`
- Create: `vendor/tesseract/eng.traineddata` (binary, committed)
- Create: `scripts/ocr-smoke.mjs`
- Modify: `package.json`
- Modify: `src/config.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `recognize(imageBytes: Buffer|Uint8Array) => Promise<{ text: string, meanConfidence: number, wordCount: number }>` — `meanConfidence` is 0..1
  - `shutdownOcr() => Promise<void>` — terminates the shared worker; called by tests and on server shutdown

- [ ] **Step 1: Install the dependency**

```bash
npm install tesseract.js
```

- [ ] **Step 2: Fetch and commit the language data**

`_fast` variant, matching the accuracy tier tesseract.js defaults to:

```bash
mkdir -p vendor/tesseract && curl -L -o vendor/tesseract/eng.traineddata https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata && ls -l vendor/tesseract/eng.traineddata
```

Record the actual byte size from that `ls` output — it goes in the README in Step 3 and in the spec in Step 9. Do not copy a number from this plan; measure it.

- [ ] **Step 3: Write `vendor/tesseract/README.md`**

```markdown
# Vendored Tesseract language data

`eng.traineddata`, the `tessdata_fast` variant, from
https://github.com/tesseract-ocr/tessdata_fast

**Why it is committed rather than downloaded.** tesseract.js fetches this from a
CDN on first use. That would make page-image comparison depend on the internet
and fail closed in the offline setting CerVer is built for. `src/ocr.js` points
`langPath` here so nothing is ever fetched at runtime.

**Why it is not in `public/vendor/`.** `public/` is served statically to every
browser. This file is read only by the server; putting it there would ship
megabytes to every phone that loads the scan page and never use them.

Size: <bytes from step 2>. English only — see spec §8.
```

- [ ] **Step 4: Write the smoke script**

`node --test` must not depend on an OCR engine, so the engine is proven by a script instead. It takes the image path as an argument — `frames/` is gitignored and there is no committed page photograph to default to, and inventing one by rendering text would be a synthetic sample proving nothing about paper.

Create `scripts/ocr-smoke.mjs`:

```js
// Proves src/ocr.js works against the INSTALLED tesseract.js and the vendored
// language data — with the network unavailable, which is the point.
//
//   node scripts/ocr-smoke.mjs <any-image-with-text.jpg>
//
// Not part of `npm test`: it loads a wasm engine and takes seconds. It proves
// the engine is WIRED UP. It measures nothing — accuracy is Task 8's job, on
// photographs of paper.
import fs from 'node:fs/promises';
import { recognize, shutdownOcr } from '../src/ocr.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/ocr-smoke.mjs <image-with-text>');
  process.exit(2);
}

const got = await recognize(await fs.readFile(file));
await shutdownOcr();

console.log(`confidence ${got.meanConfidence.toFixed(3)}, ${got.wordCount} words`);
console.log('---');
console.log(got.text.slice(0, 400));
console.log('---');
if (got.wordCount === 0) {
  console.error('FAIL: no text came back at all — the engine is not reading');
  process.exit(1);
}
console.log('OK');
```

- [ ] **Step 5: Write `src/ocr.js`**

```js
// Image bytes -> text. The only nondeterministic part of page-image comparison;
// everything that decides what a difference MEANS lives in pageCompare.js.
//
// Language data is vendored (vendor/tesseract/) and langPath points at it, so
// nothing is fetched at runtime. See spec §8.
import { createWorker } from 'tesseract.js';
import config from './config.js';

let workerPromise = null;

// Starting a worker costs seconds, so one is shared. Created lazily: a server
// that never receives a page image never pays for it.
function worker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      langPath: config.ocrLangPath,
      gzip: false, // the vendored file is uncompressed
      cachePath: config.ocrLangPath,
    });
  }
  return workerPromise;
}

export async function recognize(imageBytes) {
  const w = await worker();
  const { data } = await w.recognize(Buffer.from(imageBytes));
  const text = String(data?.text ?? '');
  return {
    text,
    // tesseract reports 0..100; the rest of the app talks in 0..1.
    meanConfidence: Number.isFinite(data?.confidence) ? data.confidence / 100 : 0,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

export async function shutdownOcr() {
  if (!workerPromise) return;
  const w = await workerPromise;
  workerPromise = null;
  await w.terminate();
}
```

- [ ] **Step 6: Add `ocrLangPath` to `src/config.js`**

`config.js` exports one default object of `path.resolve`d values with `CERVER_*` env overrides, and `src/app.js` reads it as `config.iisBaseUrl`. Add a line inside that object, keeping the shape:

```js
  ocrLangPath: process.env.CERVER_OCR_LANGPATH || path.resolve('vendor', 'tesseract'),
```

No new export style — `src/ocr.js` already imports the default object and reads `config.ocrLangPath`.

- [ ] **Step 7: Run the smoke test**

Point it at any image containing printed text — a screenshot, a phone photo, anything on the machine:

```bash
node scripts/ocr-smoke.mjs <path-to-any-image-with-text>
```

Expected: a confidence, a word count, the first 400 characters of text, then `OK`.

Then prove it does not need the network — disconnect the machine from the internet (or block it) and run it again:

```bash
node scripts/ocr-smoke.mjs <same-image>
```

Expected: identical result. **If this fetches anything, `langPath`/`cachePath` are wrong and the offline guarantee in spec §8 is not met.** Fix before continuing.

- [ ] **Step 8: Record the measured size in the spec**

In `docs/superpowers/specs/2026-08-13-page-image-ocr-design.md` §8, replace "The exact committed size is recorded in the plan's setup task, measured rather than estimated." with the byte size measured in Step 2.

- [ ] **Step 9: Confirm the test suite is unaffected**

```bash
npm test
```

Expected: no new failures, and no test takes noticeably longer — nothing in `npm test` should load the OCR engine.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/ocr.js src/config.js vendor/tesseract scripts/ocr-smoke.mjs docs/superpowers/specs/2026-08-13-page-image-ocr-design.md
git commit -m "feat(ocr): read text off an image, with language data vendored for offline use"
```

---

### Task 5: Orchestration

Join the two: fetch the authoritative page text from the sealed PDF on file, OCR the image, compare, log.

**Files:**
- Create: `src/verifyPageImage.js`
- Create: `test/verifyPageImage.test.js`

**Interfaces:**
- Consumes: `recognize` (Task 4), `compare` (Task 3), `extractPageTexts` from `src/pdfTools.js`, `openDb` from `src/db.js`.
- Produces: `verifyPageImage(db, imageBytes, { iisNo, k, clientHint, ocr }) => Promise<Report & { iisNo, k }>` where `status` may additionally be `'no_record_copy'`. `ocr` is an injectable `recognize` — defaulting to the real one — so tests never load the engine.

- [ ] **Step 1: Write the failing test**

Create `test/verifyPageImage.test.js`:

```js
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
const BODY = [
  'ORDER OF THE REGIONAL DIRECTOR. Issued to ACME MINING CORPORATION.',
  'A fine of P50,000.00 is imposed under Section 12 of the rules, and the',
  'respondent shall comply within 15 days of receipt of this order.',
].join(' ');

// The image is never opened in these tests — a stub stands in for the engine, so
// the suite stays deterministic and offline. Task 8 exercises the real one.
const stubOcr = (text, meanConfidence = 0.9) => async () => ({
  text,
  meanConfidence,
  wordCount: text.split(/\s+/).filter(Boolean).length,
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test test/verifyPageImage.test.js
```

Expected: FAIL — `Cannot find module '.../src/verifyPageImage.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/verifyPageImage.js`:

```js
import fs from 'node:fs/promises';
import { extractPageTexts } from './pdfTools.js';
import { compare, THRESHOLDS } from './pageCompare.js';
import { recognize as defaultRecognize } from './ocr.js';

// Compare a photograph of a printed page against the page as it was sealed.
//
// EVIDENCE, NOT PROOF (spec §2). The seal is what verifies a page; this only
// says which values on the sheet disagree with the record, and it never changes
// a seal verdict. A photograph that cannot be read costs the document nothing.

// Below this, the reading is too poor to say anything about the page. Reported
// as a request for a better photo — never as a finding.
const MIN_CONFIDENCE = 0.5;

export async function verifyPageImage(
  db,
  imageBytes,
  { iisNo, k, clientHint = null, ocr = defaultRecognize } = {}
) {
  const log = (status) => {
    db?.prepare(
      'INSERT INTO verify_log (ts, queried_id, resolved_iis_no, outcome, path, client_hint) VALUES (?,?,?,?,?,?)'
    ).run(new Date().toISOString(), `${iisNo}/p${k}`, iisNo, `page_image_${status}`, 'public', clientHint);
  };
  const done = (report) => {
    log(report.status);
    return { ...report, iisNo, k };
  };
  const bare = (status) => done({ status, similarity: 0, findings: [], suppressed: 0 });

  const row = db?.prepare('SELECT sealed_pdf_path FROM pages WHERE iis_no=? AND page_no=?').get(iisNo, k);
  if (!row?.sealed_pdf_path) return bare('no_record_copy');

  let authText;
  try {
    const bytes = await fs.readFile(row.sealed_pdf_path);
    authText = (await extractPageTexts(bytes))[k - 1];
  } catch {
    // The row points at a file that is gone or unreadable. That is a gap in the
    // record, not evidence about the sheet in someone's hand.
    return bare('no_record_copy');
  }
  if (!authText) return bare('no_record_copy');

  const read = await ocr(imageBytes);
  if (read.meanConfidence < MIN_CONFIDENCE || read.wordCount < THRESHOLDS.minWords) {
    return bare('image_unreadable');
  }

  return done(compare(read.text, authText));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test test/verifyPageImage.test.js
```

Expected: PASS, 6 tests.

If `an unsealed page -> no_record_copy` throws instead, the `db.prepare(...).get()` returned `undefined` and `row?.` is doing its job — check the test's `iisNo` really is absent from `pages`.

- [ ] **Step 5: Run the whole suite**

```bash
npm test
```

Expected: no new failures. Confirm the run did not get slower: nothing here should import a live OCR worker, because `ocr` is injected in every test.

- [ ] **Step 6: Commit**

```bash
git add src/verifyPageImage.js test/verifyPageImage.test.js
git commit -m "feat(ocr): compare a photographed page against the page as it was sealed"
```

---

### Task 6: The route

**Files:**
- Modify: `src/app.js` (add after the `/api/verify-document` route, ~line 171)
- Create: `test/appVerifyPageImage.test.js`

**Interfaces:**
- Consumes: `verifyPageImage` (Task 5).
- Produces: `POST /api/verify-page-image` — multipart with fields `doc`, `k` and one file part; returns the Task 5 report as JSON.

- [ ] **Step 1: Write the failing test**

Read `test/appSeal.test.js` first for how this suite builds multipart requests against `buildApp`, and follow it. Create `test/appVerifyPageImage.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';

const kp = { currentKid: () => '1', secretFor: () => 'test-secret' };

function form(fields, fileBytes) {
  const b = '----cerver';
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="page.jpg"\r\n` +
    'Content-Type: image/jpeg\r\n\r\n'
  ));
  parts.push(Buffer.from(fileBytes));
  parts.push(Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

test('missing file -> 400', async () => {
  const app = buildApp({ db: openDb(':memory:'), verify: () => ({}), keyProvider: kp, sealedDir: '.' });
  const res = await app.inject({
    method: 'POST', url: '/api/verify-page-image',
    headers: { 'content-type': 'multipart/form-data; boundary=----cerver' },
    payload: Buffer.from('----cerver--\r\n'),
  });
  assert.equal(res.statusCode, 400);
});

test('missing doc or k -> 400', async () => {
  const app = buildApp({ db: openDb(':memory:'), verify: () => ({}), keyProvider: kp, sealedDir: '.' });
  const { body, headers } = form({ k: '1' }, Buffer.alloc(8));
  const res = await app.inject({ method: 'POST', url: '/api/verify-page-image', headers, payload: body });
  assert.equal(res.statusCode, 400);
});

test('an unknown document answers no_record_copy without running OCR', async () => {
  const app = buildApp({ db: openDb(':memory:'), verify: () => ({}), keyProvider: kp, sealedDir: '.' });
  const { body, headers } = form({ doc: 'R1-2099-999999', k: '1' }, Buffer.alloc(8));
  const res = await app.inject({ method: 'POST', url: '/api/verify-page-image', headers, payload: body });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'no_record_copy');
});
```

The third test is the important one: it proves an unknown document short-circuits before the engine loads, which is why this file can live in `npm test`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test test/appVerifyPageImage.test.js
```

Expected: FAIL — 404 from Fastify, since the route does not exist.

- [ ] **Step 3: Add the route to `src/app.js`**

Insert directly after the `/api/verify-document` handler:

```js
  // ---- Compare a photograph of a printed page against the record ----
  //
  // EVIDENCE, NOT PROOF. The seal verifies a page; this reports which values on
  // the sheet disagree with the page as it was sealed, and never changes a seal
  // verdict. Same answer for every caller — see spec §6 on why there is no
  // staff gate here.
  //
  // Raised body limit for the same reason /api/frame has one: a phone photo is
  // megabytes, and Fastify's 1 MB default would reject it as a server error.
  app.post('/api/verify-page-image', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'No image uploaded.' });
    const iisNo = (data.fields?.doc?.value || '').trim();
    const k = Number(data.fields?.k?.value);
    if (!iisNo || !Number.isFinite(k) || k < 1) {
      return reply.code(400).send({ error: 'Need the control number and page number.' });
    }
    const imageBytes = await data.toBuffer();
    const { verifyPageImage } = await import('./verifyPageImage.js');
    return verifyPageImage(db, imageBytes, {
      iisNo,
      k,
      clientHint: req.headers['user-agent'] ?? null,
    });
  });
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test test/appVerifyPageImage.test.js
```

Expected: PASS, 3 tests.

If the multipart field values come back `undefined`, check how `@fastify/multipart` is configured in `buildApp` — `/api/seal` and `/api/verify-document` both read `data.fields?.X?.value`, so follow whichever shape they use.

- [ ] **Step 5: Run the whole suite**

```bash
npm test
```

Expected: no new failures.

- [ ] **Step 6: Commit**

```bash
git add src/app.js test/appVerifyPageImage.test.js
git commit -m "feat(api): accept a page photograph and answer with what differs"
```

---

### Task 7: The attach affordance and its report

Hang "Attach a photo of this page" on a verified page result, and render the outcome so it never reads as a verdict.

**Files:**
- Modify: `public/index.html` (page-mode section, ~line 96)
- Modify: `public/app.js` (`renderPageResult`, ~line 655–691)
- Modify: `public/check.css`

**Interfaces:**
- Consumes: `POST /api/verify-page-image` (Task 6).
- Produces: no exports; UI only.

- [ ] **Step 1: Add the hidden file input to `public/index.html`**

Inside the `#mode-page` section, after the `</details>` that closes "Type it instead":

```html
          <!-- Attaching a photo is offered only once a page has verified, so the
               document and page are already known. The input lives here and is
               driven by a button rendered into the result card. -->
          <input id="pageImage" type="file" accept="image/*" capture="environment" hidden />
```

- [ ] **Step 2: Add the button to the verified result in `public/app.js`**

In `renderPageResult`, the verified branch currently ends with the "Compare with the real page" button. Add a second button beside it, inside the same `${data.iisNo && data.k ? ... : ''}` block:

```js
      ${data.iisNo && data.k
        ? '<button class="btn btn-primary" type="button" id="compareBtn">Compare with the real page</button>' +
          '<button class="btn btn-ghost" type="button" id="attachBtn">Attach a photo of this page</button>' +
          '<div id="ocrOut"></div>'
        : ''}
```

- [ ] **Step 3: Wire the button, below the existing `compareBtn` listener**

```js
  // Reading the words off a photograph is EVIDENCE, not proof — it can neither
  // confirm nor withdraw the seal verdict above, so it renders in its own slot
  // beneath and never restyles the verdict card.
  const imgEl = document.getElementById('pageImage');
  document.getElementById('attachBtn')?.addEventListener('click', () => imgEl.click());
  // Assignment, not addEventListener: the input outlives each render, and a
  // listener added per render would stack and fire once per page verified.
  imgEl.onchange = async () => {
    const file = imgEl.files[0];
    if (!file) return;
    const out = document.getElementById('ocrOut');
    out.innerHTML = '<p class="note" style="margin-top:0.7rem">Reading the photo…</p>';
    const fd = new FormData();
    fd.append('doc', data.iisNo);
    fd.append('k', String(data.k));
    fd.append('file', file, file.name);
    try {
      const res = await fetch('/api/verify-page-image', { method: 'POST', body: fd });
      renderOcrReport(out, await res.json());
    } catch {
      out.innerHTML = '<p class="note" style="margin-top:0.7rem">Couldn’t reach the service.</p>';
    }
    imgEl.value = '';
  };
```

- [ ] **Step 4: Add `renderOcrReport`, after `renderPageResult`**

```js
// Deliberately plain. No stamp, no --ok green, no "verified" — those belong to
// the seal. A clean result says nothing was found, which is not the same as
// saying the page is genuine (spec §2).
function renderOcrReport(out, rep) {
  const shell = (ink, head, body) =>
    `<div class="ocr-note" style="--state:${ink}"><p class="eyebrow">${esc(head)}</p>${body}</div>`;

  if (rep.status === 'no_record_copy')
    return (out.innerHTML = shell('var(--slate)', 'Nothing to compare against',
      '<p class="msg">No authoritative copy of this page is on file. The seal result above still stands.</p>'));

  if (rep.status === 'image_unreadable')
    return (out.innerHTML = shell('var(--slate)', 'Couldn’t read the photo',
      '<p class="msg">Take it again — flat on the page, in even light, filling the frame. This says nothing about the document.</p>'));

  if (rep.status === 'page_differs')
    return (out.innerHTML = shell('var(--warn)', 'This doesn’t look like that page',
      '<p class="msg">The wording is too different to compare value by value. Open the real page and look.</p>'));

  const material = rep.findings.filter((f) => f.severity === 'material');
  const tolerant = rep.findings.filter((f) => f.severity === 'tolerant');

  const row = (f) => {
    const where = f.line ? `line ${f.line}` : 'not on the record page';
    const said = f.expected === null
      ? `the photo has <b>${esc(f.found)}</b>, the record has no such ${esc(f.cls)}`
      : `record <b>${esc(f.expected)}</b> · photo <b>${esc(f.found ?? 'nothing')}</b>`;
    return `<li><span class="pill" style="background:var(--slate)">${esc(f.cls)}</span> ${said} <span style="color:var(--muted)">(${esc(where)})</span></li>`;
  };

  const head = material.length
    ? shell('var(--warn)', `${material.length} thing${material.length > 1 ? 's' : ''} worth checking`,
        `<ul class="more open" style="list-style:none;padding:0;margin-top:0.6rem">${material.map(row).join('')}</ul>
         <p class="note" style="margin-top:0.6rem">Read these against the real page before drawing a conclusion — a photograph can be misread.</p>`)
    : shell('var(--slate)', 'Nothing found',
        '<p class="msg">Every amount, date and duration on the record was found on the photo. This is not a verification — only the seal verifies.</p>');

  const rest = (tolerant.length || rep.suppressed)
    ? `<details class="ocr-note" style="--state:var(--slate)"><summary>${tolerant.length + rep.suppressed} difference${tolerant.length + rep.suppressed > 1 ? 's' : ''} put down to the camera</summary>
         <ul style="list-style:none;padding:0;margin-top:0.5rem">${tolerant.map(row).join('')}</ul>
         <p class="note">Wording differences of this kind are usually how the photo read, not how the page reads.</p>
       </details>`
    : '';

  out.innerHTML = head + rest;
}
```

- [ ] **Step 5: Add `.ocr-note` to `public/check.css`**

Append, after the `.report` rules (~line 400):

```css
/* Page-photo comparison. Deliberately quieter than .verdict and .report: no
   stamp, a thin LEFT rule rather than the heavy top rule those use, and no
   card elevation. It reports evidence, not a verdict, and must not be
   mistakable for one at a glance. */
.ocr-note {
  margin-top: 0.8rem;
  padding: 0.7rem 0.8rem;
  background: transparent;
  border: 1px solid var(--rule);
  border-left: 3px solid var(--state, var(--slate));
  border-radius: 3px;
}
.ocr-note .msg { margin: 0.35rem 0 0; font-size: 0.82rem; }
.ocr-note li {
  display: flex;
  gap: 0.45rem;
  align-items: baseline;
  flex-wrap: wrap;
  padding: 0.3rem 0;
  border-bottom: 1px solid var(--rule);
  font-size: 0.8rem;
}
.ocr-note li:last-child { border-bottom: 0; }
.ocr-note .pill {
  font-family: var(--display);
  font-size: 0.58rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.1rem 0.35rem;
  border-radius: 2px;
  color: #fff;
}
.ocr-note summary {
  font-size: 0.78rem;
  color: var(--muted);
  cursor: pointer;
  margin-top: 0.5rem;
}
```

The `--state` values `renderOcrReport` passes are `var(--slate)` and `var(--warn)` only. `var(--ok)` is never passed, because green belongs to the seal.

- [ ] **Step 6: Verify in the browser**

```bash
npm start
```

Then, with the preview tools: open `http://localhost:3100`, verify a page whose document has a sealed copy on file (seal a PDF first via the seal page if the DB is empty), and confirm:
- The "Attach a photo of this page" button appears only on a verified result.
- Attaching any image produces a report card that is visibly quieter than the verdict above it.
- The verdict card's colour and stamp do not change when the report arrives.
- `read_console_messages` shows no errors.

Screenshot the result for the commit message evidence.

- [ ] **Step 7: Run the whole suite**

```bash
npm test
```

Expected: no new failures.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/app.js public/check.css
git commit -m "feat(ui): offer a photo of the page, and report on it without pretending it is a verdict"
```

---

### Task 8: Calibration against real photographs, and the README

The thresholds shipped in Task 3 are guesses. This task replaces them with measured values, and it is the one that decides whether the feature is fit to announce.

**This task requires a human with a printer and a phone.** It cannot be completed by an agent alone. If you are an agent, complete Steps 1–2 and 7, then stop and hand Steps 3–6 to the user with the script ready to run.

**Files:**
- Create: `scripts/ocr-calibrate.mjs`
- Create: `test/fixtures/pages/` (photographs, committed)
- Modify: `src/pageCompare.js` (THRESHOLDS)
- Modify: `src/verifyPageImage.js` (MIN_CONFIDENCE)
- Modify: `docs/superpowers/specs/2026-08-13-page-image-ocr-design.md` (§9.2)
- Modify: `README.md`

**Interfaces:**
- Consumes: `recognize` (Task 4), `compare` (Task 3).
- Produces: no exports.

- [ ] **Step 1: Write the calibration script**

Create `scripts/ocr-calibrate.mjs`:

```js
// Measure the page-image comparison against REAL PHOTOGRAPHS.
//
//   node scripts/ocr-calibrate.mjs <sealed.pdf> <photos-dir>
//
// Each photo is named "<pageNo>-<label>.jpg", where label is one of:
//   genuine   an unaltered printed page, photographed
//   altered   a page with a KNOWN changed value
//   poor      deliberately bad capture (angled, shadowed, cropped)
//   other     a page from a different document
//
// Renders of the PDF are NOT admissible here (spec §9.2). The size ladder
// already measured a capture bug off synthetic samples and reported it as a
// property of ink; this exists so that does not happen twice.
import fs from 'node:fs/promises';
import path from 'node:path';
import { recognize, shutdownOcr } from '../src/ocr.js';
import { compare } from '../src/pageCompare.js';
import { extractPageTexts } from '../src/pdfTools.js';

const [pdfPath, dir] = process.argv.slice(2);
if (!pdfPath || !dir) {
  console.error('usage: node scripts/ocr-calibrate.mjs <sealed.pdf> <photos-dir>');
  process.exit(2);
}

const texts = await extractPageTexts(await fs.readFile(pdfPath));
const files = (await fs.readdir(dir)).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();

console.log(['file', 'label', 'similarity', 'confidence', 'words', 'material', 'suppressed', 'status'].join('\t'));
const rows = [];
for (const f of files) {
  const [pageNo, label = 'genuine'] = path.parse(f).name.split('-');
  const read = await recognize(await fs.readFile(path.join(dir, f)));
  const rep = compare(read.text, texts[Number(pageNo) - 1] ?? '');
  const material = rep.findings.filter((x) => x.severity === 'material');
  rows.push({ f, label, rep, read, material });
  console.log([
    f, label, rep.similarity.toFixed(3), read.meanConfidence.toFixed(3),
    read.wordCount, material.length, rep.suppressed, rep.status,
  ].join('\t'));
}
await shutdownOcr();

const genuine = rows.filter((r) => r.label === 'genuine');
const falsePositives = genuine.filter((r) => r.material.length > 0);
console.log('\n--- criterion 1: zero material false positives on genuine pages ---');
console.log(`${genuine.length} genuine page(s), ${falsePositives.length} with material findings`);
for (const r of falsePositives) {
  console.log(`  ${r.f}: ${r.material.map((m) => `${m.cls} ${m.expected} -> ${m.found} (${m.reason})`).join('; ')}`);
}

const sims = (label) => rows.filter((r) => r.label === label).map((r) => r.rep.similarity);
const min = (a) => (a.length ? Math.min(...a).toFixed(3) : 'n/a');
const max = (a) => (a.length ? Math.max(...a).toFixed(3) : 'n/a');
console.log('\n--- criterion 2: the samePageMin gap ---');
console.log(`genuine similarity floor: ${min(sims('genuine'))}`);
console.log(`other-page similarity ceiling: ${max(sims('other'))}`);
console.log('  pick samePageMin between these two, with margin on both sides.');

console.log('\n--- criterion 3: poor captures must land in image_unreadable ---');
for (const r of rows.filter((x) => x.label === 'poor')) {
  console.log(`  ${r.f}: confidence ${r.read.meanConfidence.toFixed(3)}, words ${r.read.wordCount}, status ${r.rep.status}`);
}

console.log('\n--- criterion 4: known alterations are caught ---');
for (const r of rows.filter((x) => x.label === 'altered')) {
  console.log(`  ${r.f}: ${r.material.length} material — ${r.material.map((m) => `${m.expected} -> ${m.found}`).join('; ') || 'CAUGHT NOTHING'}`);
}

process.exit(falsePositives.length === 0 ? 0 : 1);
```

- [ ] **Step 2: Verify the script runs end to end on whatever images exist**

Even with one throwaway photo, this must not crash:

```bash
node scripts/ocr-calibrate.mjs scripts/print-test-sealed.pdf test/fixtures/pages
```

Expected: a table and four criterion sections. A non-zero exit here is a *result*, not a script failure.

- [ ] **Step 3: (human) Print and photograph**

Seal a real multi-page EMB document, print it, and photograph with the phone that will actually be used:

- at least 5 pages labelled `genuine` — ordinary conditions, handheld, office light
- at least 1 labelled `altered` — reprint one page with a **known** changed amount or duration, and write down what was changed
- at least 3 labelled `poor` — one angled ~30°, one in hard shadow, one with a corner out of frame
- at least 1 labelled `other` — a page from a different document

Save into `test/fixtures/pages/` as `<pageNo>-<label>.jpg`.

- [ ] **Step 4: (human) Run the calibration**

```bash
node scripts/ocr-calibrate.mjs <the-sealed.pdf> test/fixtures/pages
```

- [ ] **Step 5: (human) Set the thresholds from the output**

- `samePageMin` — between the genuine floor and the other-page ceiling, with margin on both sides. If there is no gap, the feature does not work as designed; stop and report that rather than picking a number inside the overlap.
- `MIN_CONFIDENCE` in `src/verifyPageImage.js` — above every `poor` capture's confidence, below every `genuine` one.
- Remove the `PROVISIONAL` comment above `THRESHOLDS` and replace it with the date, the number of photographs, and the measured floors and ceilings.

If criterion 1 does not hold — any genuine page produces a material finding — **do not raise the threshold to hide it.** Find which token class is at fault and fix its matching rule, then re-run. Spec §9.2 makes this the binding criterion because one false alarm per genuine page ends the feature's usefulness.

- [ ] **Step 6: (human) Record the numbers in the spec**

In §9.2, replace the four "to be established" criteria with what was measured: the photo count, the two similarity bounds, the chosen thresholds, and whether the known alteration was caught.

- [ ] **Step 7: Update the README**

Two edits.

In the verification section, the line `- **Full check** — upload the PDF → …(exact re-hash; no OCR).` gains a sibling:

```markdown
- **Photo of a page** — after a seal verifies, attach a photograph of the sheet
  and every amount, date and duration on the record is checked against what the
  camera read. This is **evidence, not proof**: OCR is lossy, so a clean result
  reads "nothing found", never "verified". It narrows the honest limit below
  without removing it.
```

And in the honest-limit paragraph, after "…or a human comparing against the authoritative page the app displays.", add:

```markdown
The photo check sits between those two. It is the human comparison done faster
and without skipping the digit that matters, not a third kind of proof.
```

- [ ] **Step 8: Run the whole suite**

```bash
npm test
```

Expected: no new failures.

- [ ] **Step 9: Commit**

```bash
git add scripts/ocr-calibrate.mjs test/fixtures/pages src/pageCompare.js src/verifyPageImage.js docs/superpowers/specs/2026-08-13-page-image-ocr-design.md README.md
git commit -m "test(ocr): calibrate the page-image comparison against photographs of paper"
```

---

## Notes for whoever executes this

**Task 8 is not optional polish.** Tasks 1–7 produce a feature that runs; Task 8 is what establishes whether it is honest. Until criterion 1 holds on real photographs, the thresholds are guesses and the feature should not be announced to staff. If you finish Task 7 and stop, say so plainly rather than reporting the feature as done.

**Renders are not photographs.** This comes up in Task 4 (the smoke image) and Task 8 (the fixtures). A render has perfect contrast, no perspective, no shadow, no paper texture, no dot gain. It can prove wiring; it cannot measure accuracy. This project has already acted three times on numbers that came from synthetic samples.

**Do not reintroduce a staff gate.** If you find yourself adding `staff=1` to make some field conditional, re-read spec §6 — the flag is a checkbox anyone can tick, `/api/page-image` serves the whole authoritative page ungated, and the distinction is being deleted from this codebase as this feature is added.
