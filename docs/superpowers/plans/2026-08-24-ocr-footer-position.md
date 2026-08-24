# OCR Footer Position Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a garbled-OCR footer stamp from being mistaken for a genuine second control number on real photographs, without weakening the rule that any other digit difference is always material.

**Architecture:** A new pure module, `src/ocrFooter.js`, clusters OCR word positions into lines, identifies the bottommost line, and — only when that line's *content shape* looks like a footer stamp and never like a money/date/duration value — removes it from the text before `compare()` ever sees it. `src/pageCompare.js` is not modified at all.

**Tech Stack:** Node ESM, `node:test`, no new dependencies — reuses `extractTokens` already exported from `src/pageCompare.js`.

**Spec:** [`docs/superpowers/specs/2026-08-24-ocr-footer-position-design.md`](../specs/2026-08-24-ocr-footer-position-design.md)

## Global Constraints

- **`src/pageCompare.js` is not modified in any task in this plan.** It stays exactly as reviewed. (Spec §1, §3.)
- **No content-similarity forgiveness for reference values, anywhere.** The mechanism decides purely by position (bottommost line) plus a content *shape* gate (reference/citation-shaped, zero money/date/duration-shaped) — never by comparing digits to a known-good value and deciding they're "close enough." (Spec §1, §4.)
- **Default is untouched text.** If the bottommost line doesn't pass the gate, or `words` is missing/empty, `stripOcrFooter` returns its input completely unchanged — no error, no different comparison outcome than if this feature didn't exist. (Spec §4.)
- **The accepted blind spot must be provable, not just asserted.** A test constructs a tampered reference deliberately placed at the bottommost-line position and asserts it is *not* caught by this mechanism — the limit made explicit in code, not left implicit. (Spec §5.)
- House style: 2-space indent, single quotes, semicolons, ~100 col, ESM.
- Baseline before this plan: `npm test` passes in full (should currently be 215 — confirm the actual count when you start, since the exact number isn't load-bearing here).

---

### Task 1: `stripOcrFooter()` — pure module

**Files:**
- Create: `src/ocrFooter.js`
- Create: `test/ocrFooter.test.js`

**Interfaces:**
- Consumes: `extractTokens` from `src/pageCompare.js` (already exported, signature `extractTokens(text) => Array<{cls, value, line}>`, classes include `'money' | 'date' | 'duration' | 'reference' | 'citation' | 'name'`).
- Produces: `stripOcrFooter(text, words) => string`, where `words` is `Array<{ text: string, confidence: number, bbox: {x0, y0, x1, y1} }>` (the exact shape `recognize()` in `src/ocr.js` already returns). Task 2 wires this into `verifyPageImage.js`.

- [ ] **Step 1: Write the failing tests**

Create `test/ocrFooter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripOcrFooter } from '../src/ocrFooter.js';

// bbox y-coordinates grow downward (image/screen convention, same as
// Tesseract's own bbox). A word is 10px tall by default here; x-position
// only needs to keep words distinct on the same line, it plays no role in
// clustering.
let nextX = 0;
const wordAt = (text, y, opts = {}) => {
  const x0 = opts.x0 ?? nextX;
  nextX = x0 + 20;
  return {
    text,
    confidence: opts.confidence ?? 0.8,
    bbox: { x0, y0: y, x1: x0 + 15, y1: y + (opts.height ?? 10) },
  };
};
const resetX = () => { nextX = 0; };

test('removes a garbled footer line that still carries a misread reference', () => {
  resetX();
  const words = [
    wordAt('Control', 0), wordAt('No.', 0), wordAt('R1-2026-010734', 0), wordAt('is', 0), wordAt('confirmed.', 0),
  ];
  resetX();
  // The actual OCR reading of a real garbled footer, pulled from
  // test/fixtures/pages/2-genuine-c.jpg during 2026-08-24 calibration.
  const footerWords = ['4', '7', 'Be', 'R1-2026-010794', '=', '27>', '-', 'tea']
    .map((t) => wordAt(t, 500));
  const all = [...words, ...footerWords];
  const text = all.map((w) => w.text).join(' ');

  const result = stripOcrFooter(text, all);

  assert.ok(!result.includes('R1-2026-010794'), 'the garbled footer reference should be removed');
  assert.ok(result.includes('R1-2026-010734'), 'the real body reference must survive');
  assert.ok(result.includes('confirmed.'), 'body text must survive');
});

test('the gate refuses a last line that also states a value (money/date/duration)', () => {
  resetX();
  const words = [wordAt('Total', 0), wordAt('due', 0)];
  resetX();
  const lastLine = ['Total', 'P50,000.00', 'per', 'R1-2026-010734'].map((t) => wordAt(t, 500));
  const all = [...words, ...lastLine];
  const text = all.map((w) => w.text).join(' ');

  const result = stripOcrFooter(text, all);

  assert.equal(result, text, 'a line carrying a money value must never be removed, even if it also looks reference-shaped');
});

test('leaves a genuine body reference untouched when the bottommost line is not footer-shaped', () => {
  resetX();
  const bodyWithReference = ['Per', 'R1-2026-010734', 'the', 'terms', 'apply.'].map((t) => wordAt(t, 0));
  resetX();
  const plainLastLine = ['Page', '2', 'of', '3'].map((t) => wordAt(t, 500));
  const all = [...bodyWithReference, ...plainLastLine];
  const text = all.map((w) => w.text).join(' ');

  const result = stripOcrFooter(text, all);

  assert.equal(result, text, 'nothing should be removed when the bottommost line has no reference/citation shape');
});

test('an empty or missing words array leaves the text completely unchanged', () => {
  assert.equal(stripOcrFooter('some ordinary text', []), 'some ordinary text');
  assert.equal(stripOcrFooter('some ordinary text', undefined), 'some ordinary text');
});

test('the accepted blind spot: a tampered reference placed at the footer position is not caught by this mechanism', () => {
  resetX();
  const words = [wordAt('Control', 0), wordAt('No.', 0), wordAt('R1-2026-010734', 0)];
  resetX();
  // A footer-shaped last line (reference only, nothing else) whose reference
  // digit was deliberately changed -- indistinguishable, by shape alone, from
  // an innocently misread one. This is the boundary the design spec (§2, §6)
  // names directly rather than leaving implicit.
  const tamperedFooter = ['EMB', 'R1-2026-010799', 'p2/3', 'K1', 'ABCD-EFGH'].map((t) => wordAt(t, 500));
  const all = [...words, ...tamperedFooter];
  const text = all.map((w) => w.text).join(' ');

  const result = stripOcrFooter(text, all);

  assert.ok(!result.includes('R1-2026-010799'), 'documents the known limit: this value is excluded, not flagged');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test test/ocrFooter.test.js
```

Expected: FAIL — `Cannot find module '.../src/ocrFooter.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/ocrFooter.js`:

```js
// Excludes a page's bottommost OCR'd line from comparison when it looks
// footer-shaped -- reference/citation content, never a money/date/duration
// value -- regardless of whether OCR preserved the footer's exact printed
// text shape. Position, not text, is the signal: a footer is always a
// page's last printed line, by construction.
//
// Pure. No I/O, no OCR engine. Reuses extractTokens (src/pageCompare.js,
// unmodified) as the content gate rather than reimplementing pattern
// matching. See docs/superpowers/specs/2026-08-24-ocr-footer-position-design.md

import { extractTokens } from './pageCompare.js';

const FOOTER_LIKE_CLASSES = new Set(['reference', 'citation']);
const STRICT_VALUE_CLASSES = new Set(['money', 'date', 'duration']);

// Escapes a word's text for use inside a RegExp alternation/sequence -- word
// text can legitimately contain '.', '(', etc. (real footer/reference
// punctuation), which must be matched literally, not as regex syntax.
function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Groups words into lines by vertical position. The tolerance is derived
// from the MEDIAN word height on this photo, not a fixed pixel count, so it
// adapts to whatever resolution/distance this particular capture used.
function clusterLines(words) {
  const usable = words.filter((w) => w?.text && w.text.trim() && w.bbox);
  if (usable.length === 0) return [];

  const heights = usable
    .map((w) => w.bbox.y1 - w.bbox.y0)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  if (heights.length === 0) return [];
  const medianHeight = heights[Math.floor(heights.length / 2)];
  const tolerance = medianHeight / 2;

  const withCenters = usable
    .map((w) => ({ word: w, center: (w.bbox.y0 + w.bbox.y1) / 2 }))
    .sort((a, b) => a.center - b.center);

  const lines = [];
  let current = [];
  let currentCenter = null;
  for (const { word, center } of withCenters) {
    if (current.length === 0) {
      current = [word];
      currentCenter = center;
      continue;
    }
    if (Math.abs(center - currentCenter) <= tolerance) {
      current.push(word);
      currentCenter = (currentCenter * (current.length - 1) + center) / current.length;
    } else {
      lines.push(current);
      current = [word];
      currentCenter = center;
    }
  }
  if (current.length > 0) lines.push(current);
  // Ascending by construction (sorted by center before clustering), so the
  // last line in this array is the bottommost -- the footer candidate.
  return lines;
}

export function stripOcrFooter(text, words) {
  const safeText = String(text ?? '');
  if (!Array.isArray(words) || words.length === 0) return safeText;

  const lines = clusterLines(words);
  if (lines.length === 0) return safeText;

  const candidate = lines[lines.length - 1];
  const candidateText = candidate.map((w) => w.text).join(' ');
  if (!candidateText.trim()) return safeText;

  const tokens = extractTokens(candidateText);
  const hasFooterLikeToken = tokens.some((t) => FOOTER_LIKE_CLASSES.has(t.cls));
  const hasStrictValueToken = tokens.some((t) => STRICT_VALUE_CLASSES.has(t.cls));
  if (!hasFooterLikeToken || hasStrictValueToken) return safeText;

  // Removal uses a flexible-whitespace pattern built from the same words,
  // rather than an exact substring match on candidateText -- Tesseract's own
  // flat text may not join words with a single space the way this function
  // does for the gate check above, and an exact-substring match that
  // silently fails to find anything would leave the footer un-removed with
  // no signal that anything went wrong.
  const pattern = new RegExp(candidate.map((w) => escapeForRegex(w.text)).join('\\s+'));
  return safeText.replace(pattern, '');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test test/ocrFooter.test.js
```

Expected: PASS, 5 tests.

If `the gate refuses a last line that also states a value` fails because nothing was removed even without the fix applied yet (i.e. it passes for the wrong reason), double check `wordAt` positions actually place that line at a LARGER y than the body words -- the test asserts equality with the untouched `text`, so it would pass regardless of whether the gate logic is even reached; the test that actually exercises the gate is the first one (which must FAIL if the money-check is deleted). Confirm this by temporarily removing the `hasStrictValueToken` check and re-running -- the second test should then fail. Restore the check afterward.

- [ ] **Step 5: Run the whole suite**

```bash
npm test
```

Expected: previous count + 5, all passing.

- [ ] **Step 6: Commit**

```bash
git add src/ocrFooter.js test/ocrFooter.test.js
git commit -m "feat(ocr): locate the OCR footer by position, not exact text shape"
```

---

### Task 2: Wire into `verifyPageImage()`, confirm against the real fixture

**Files:**
- Modify: `src/verifyPageImage.js`
- Modify: `test/verifyPageImage.test.js`

**Interfaces:**
- Consumes: `stripOcrFooter` from `src/ocrFooter.js` (Task 1).
- Produces: no new exports. `verifyPageImage()`'s existing return shape is unchanged; only the text that reaches `compare()` internally is affected.

- [ ] **Step 1: Write the failing test**

Open `test/verifyPageImage.test.js`. It already has a `stubOcr(text, meanConfidence, words)` helper (added for the confidence-boxes feature) that returns `{ text, meanConfidence, wordCount, words }`. Reuse it. Add this test after the existing region-related tests:

```js
test('a garbled footer reference does not produce a false-positive finding', async () => {
  const { db } = await seed();
  const bodyText = BODY; // BODY is already defined earlier in this file
  // Reconstruct the same real garbled-footer reading used in Task 1's test,
  // as words positioned at the bottom of the page, appended after BODY's own
  // content so the OCR text plausibly represents one full page.
  const bodyWords = bodyText.split(/\s+/).filter(Boolean).map((text, i) => ({
    text, confidence: 0.8, bbox: { x0: i * 12, y0: 0, x1: i * 12 + 10, y1: 10 },
  }));
  const footerWords = ['4', '7', 'Be', 'R1-2026-010794', '=', '27>', '-', 'tea'].map((text, i) => ({
    text, confidence: 0.4, bbox: { x0: i * 12, y0: 500, x1: i * 12 + 10, y1: 510 },
  }));
  const allWords = [...bodyWords, ...footerWords];
  const ocrText = allWords.map((w) => w.text).join(' ');

  const r = await verifyPageImage(db, Buffer.alloc(1), {
    iisNo: 'R1-2026-000001', k: 1, ocr: stubOcr(ocrText, 0.9, allWords),
  });

  assert.equal(r.status, 'compared');
  assert.deepEqual(
    r.findings.filter((f) => f.severity === 'material'),
    [],
    'the garbled footer reference must not produce a material finding'
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test test/verifyPageImage.test.js
```

Expected: FAIL — a material finding of `{ cls: 'reference', reason: 'added', found: 'R1-2026-010794' }` (or similar) shows up, because `stripOcrFooter` is not wired in yet.

- [ ] **Step 3: Wire `stripOcrFooter` in**

In `src/verifyPageImage.js`, add the import:

```js
import { stripOcrFooter } from './ocrFooter.js';
```

Then change the final block (currently):

```js
  const report = compare(read.text, authText);
  const findings = locateFindings(report.findings, read.words);
  return done({ ...report, findings });
```

to:

```js
  const cleanedText = stripOcrFooter(read.text, read.words);
  const report = compare(cleanedText, authText);
  const findings = locateFindings(report.findings, read.words);
  return done({ ...report, findings });
```

Note `locateFindings` still receives the full, uncut `read.words` — it only looks up positions for whatever findings `compare()` produced, and a line excluded from comparison never produces a finding to look up in the first place, so this line does not change.

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test test/verifyPageImage.test.js
```

Expected: PASS, previous count + 1.

- [ ] **Step 5: Run the whole suite**

```bash
npm test
```

Expected: previous count + 1, all passing.

- [ ] **Step 6: Confirm against the real fixture, with the real engine**

This is the actual proof the fix works outside a reconstructed test fixture — re-run calibration against the real photograph that produced this false positive in the first place:

```bash
node scripts/ocr-calibrate.mjs scripts/print-test-sealed.pdf test/fixtures/pages
```

Expected: `2-genuine-c.jpg`'s row no longer shows a material finding, and the criterion 1 summary reports 0 genuine pages with material findings (up from the 1-of-6 it reported before this task).

If it still shows a material finding, check first whether it's the *same* one (`R1-2026-010794`) or a *different* one — a different finding is a separate, new problem, not evidence this task failed. Investigate before assuming either way.

- [ ] **Step 7: Commit**

```bash
git add src/verifyPageImage.js test/verifyPageImage.test.js
git commit -m "feat(ocr): strip the footer by position before comparing, not just by shape"
```

---

## Notes for whoever executes this

**Task 2 Step 6 is not optional.** A passing reconstructed-fixture test (Task 2 Step 4) proves the wiring is correct; it does not by itself prove the real false positive is gone, because the reconstructed word positions in these tests are synthetic approximations of the real photo's actual layout. Re-running calibration against the actual committed fixture with the real engine is what closes the loop — this project has been burned before by treating a passing synthetic test as proof of something only a real capture can show.

**Do not touch `src/pageCompare.js` or `src/sealCode.js` in either task.** Both stay exactly as already reviewed (spec §7). If a step here seems to require changing either, stop — that means the plan has a gap, not that the constraint should bend.
