# Tolerant Finding Confidence Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop itemizing a tolerant (`name`-class) "difference" as its own explained line when the underlying photo text was read with too little confidence to say anything specific about it — using the per-word confidence `ocrRegions.js` already computes, currently unused for anything but box styling.

**Architecture:** A new, narrow module (`src/ocrNoiseFilter.js`) runs strictly after `locateFindings()` in `verifyPageImage.js` and may drop a `severity: 'tolerant'` finding whose `region.confidence` is below a measured threshold. `compare()` and `locateFindings()` are both left untouched — each keeps its own existing, already-reviewed contract. `scripts/ocr-calibrate.mjs` gets fixed (it had drifted to calling the old flattened extraction instead of `extractPageTextsWithLines`, silently invalidating the previous plan's real-photo verification) and extended to report tolerant-finding confidence, which is what supplies the threshold below.

**Tech Stack:** Node.js, `node:test`. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-08-25-tolerant-finding-confidence-filter-design.md](../specs/2026-08-25-tolerant-finding-confidence-filter-design.md)

## Global Constraints

- `src/pageCompare.js`'s `compare()` must not change signature or behavior in any way.
- `src/ocrRegions.js`'s `locateFindings()` must not change — its own header comment's contract ("can only ADD a region... can never create, remove, or change" a finding) stays true of that function specifically.
- The new filter must never remove or alter a `severity: 'material'` finding, at any confidence.
- The new filter must never touch a tolerant finding with no `region` (nothing to measure).
- Tests are run from the repo root: `node --test 'test/*.test.js'`.

---

### Task 1: Fix and extend the calibration script; gather the real threshold data

**Files:**
- Modify: `scripts/ocr-calibrate.mjs`

**Interfaces:**
- Consumes: `extractPageTextsWithLines` (`src/pdfTools.js`, already exists), `locateFindings` (`src/ocrRegions.js`, already exists).
- Produces: nothing new for later tasks — this task's output is data (the printed confidence spread), read by a human (you) to pick the constant hardcoded in Task 3.

- [ ] **Step 1: Fix the stale extraction call and add confidence reporting**

In `scripts/ocr-calibrate.mjs`, change:

```js
import { compare } from '../src/pageCompare.js';
import { extractPageTexts } from '../src/pdfTools.js';
import { stripOcrFooter } from '../src/ocrFooter.js';
```

to:

```js
import { compare } from '../src/pageCompare.js';
import { extractPageTextsWithLines } from '../src/pdfTools.js';
import { stripOcrFooter } from '../src/ocrFooter.js';
import { locateFindings } from '../src/ocrRegions.js';
```

Change:

```js
const texts = await extractPageTexts(await fs.readFile(pdfPath));
```

to:

```js
const texts = await extractPageTextsWithLines(await fs.readFile(pdfPath));
```

(This alone fixes the drift: the script had kept calling the old flattened extraction after `verifyPageImage.js` switched to the line-preserving one, so the previous plan's "real-photo verification" task was unknowingly still exercising the old code path.)

Change:

```js
  const material = rep.findings.filter((x) => x.severity === 'material');
  rows.push({ f, label, rep, read, material });
```

to:

```js
  const material = rep.findings.filter((x) => x.severity === 'material');
  const located = locateFindings(rep.findings, read.words);
  const tolerant = located.filter((x) => x.severity === 'tolerant');
  rows.push({ f, label, rep, read, material, tolerant });
```

Add a new section after criterion 4 (after the existing `console.log('\n--- criterion 4: ...')` loop, before `process.exit(...)`):

```js
console.log('\n--- criterion 5: tolerant-finding confidence, for MIN_TOLERANT_CONFIDENCE ---');
for (const r of rows) {
  if (!r.tolerant.length) continue;
  const confs = r.tolerant.map((t) => (t.region ? t.region.confidence.toFixed(3) : 'none'));
  console.log(`  ${r.f} (${r.label}): ${confs.join(', ')}`);
}
console.log('  pick MIN_TOLERANT_CONFIDENCE from the gap between genuine pages\' low-confidence noise and their legitimately-read differences.');
```

- [ ] **Step 2: Run it, confirm the previous plan's swap was actually safe, and read the real threshold data**

Run: `node scripts/ocr-calibrate.mjs scripts/print-test-sealed.pdf test/fixtures/pages`

Expected, confirming the previous plan's line-preserving-extraction swap really is safe (now genuinely tested, via the fixed script): identical material/suppressed numbers to every prior calibration run this session — 10 genuine pages, 0 with material findings; `1-altered.jpg` still exactly 1 material finding (`R1-2026-010734 -> R1-2026-010784`).

Expected under the new criterion 5, matching the real data already gathered while designing this plan:

```
2-genuine.jpg (genuine): 0.960, 0.000, none, 0.820
3-genuine-b.jpg (genuine): 0.960, none
1-poor.jpg (poor): 0.000, none, 0.260
2-poor.jpg (poor): 0.310, 0.000, 0.000, 0.740
3-poor.jpg (poor): none, none, none, none
```

On genuine pages specifically, confidences cluster at two extremes — near 0 (a fully garbled word) or 0.82-0.96 (a legitimately read, merely non-material difference) — with no genuine-page data point in between. That gap is where Task 3's threshold comes from.

- [ ] **Step 3: Commit**

```bash
git add scripts/ocr-calibrate.mjs
git commit -m "$(cat <<'EOF'
fix(ocr): stop the calibration script from testing a stale extraction path

scripts/ocr-calibrate.mjs still called the old flattened extractPageTexts
directly, never picking up verifyPageImage.js's switch to
extractPageTextsWithLines -- so the previous plan's real-photo
verification task was unknowingly still exercising the old code path.
Fixed, and extended to report each tolerant finding's region confidence
(ocrRegions.js already computes this, just never printed it), which is
what the next task's threshold is measured from.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `src/ocrNoiseFilter.js` — the filter itself

**Files:**
- Create: `src/ocrNoiseFilter.js`
- Create: `test/ocrNoiseFilter.test.js`

**Interfaces:**
- Produces: `dropLowConfidenceTolerant(findings: Finding[], minConfidence: number) => Finding[]`, where a `Finding` is whatever shape `locateFindings()` already produces (`{severity, cls, line, expected, found, reason, region?}`).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Create `test/ocrNoiseFilter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropLowConfidenceTolerant } from '../src/ocrNoiseFilter.js';

const tolerantWithConfidence = (confidence) => ({
  severity: 'tolerant', cls: 'name', line: 1,
  expected: 'ACME CORP', found: 'acme corp', reason: 'text',
  region: { x0: 0, y0: 0, x1: 10, y1: 10, confidence },
});

test('a tolerant finding below the threshold is removed', () => {
  const findings = [tolerantWithConfidence(0.1)];
  assert.deepEqual(dropLowConfidenceTolerant(findings, 0.4), []);
});

test('a tolerant finding at or above the threshold is kept, unchanged', () => {
  const f = tolerantWithConfidence(0.4);
  const result = dropLowConfidenceTolerant([f], 0.4);
  assert.deepEqual(result, [f]);
});

test('a material finding is kept regardless of confidence', () => {
  const f = {
    severity: 'material', cls: 'money', line: 2,
    expected: '₱50,000.00', found: '₱500,000.00', reason: 'digit-count',
    region: { x0: 0, y0: 0, x1: 10, y1: 10, confidence: 0.01 },
  };
  assert.deepEqual(dropLowConfidenceTolerant([f], 0.9), [f]);
});

test('a tolerant finding with no region is kept', () => {
  const f = {
    severity: 'tolerant', cls: 'name', line: 3,
    expected: 'ENVIRONMENTAL MANAGEMENT BUREAU', found: null, reason: 'text',
  };
  assert.deepEqual(dropLowConfidenceTolerant([f], 0.9), [f]);
});

test('an empty findings array returns empty', () => {
  assert.deepEqual(dropLowConfidenceTolerant([], 0.4), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/ocrNoiseFilter.test.js`
Expected: FAIL — `src/ocrNoiseFilter.js` does not exist yet (module not found).

- [ ] **Step 3: Write the implementation**

Create `src/ocrNoiseFilter.js`:

```js
// Drops a tolerant (never material) finding when the underlying photo text
// was read with too little confidence to be worth itemizing as an explained
// "difference." Runs strictly AFTER ocrRegions.js's locateFindings(), which
// is what attaches region.confidence in the first place -- this module
// never re-derives it.
//
// See docs/superpowers/specs/2026-08-25-tolerant-finding-confidence-filter-design.md
//
// Contract, as narrow and explicit as locateFindings()'s own:
//   - may remove a finding with severity 'tolerant' when region.confidence
//     is below minConfidence
//   - never touches a finding with severity 'material', at any confidence
//   - never touches a finding with no region at all (nothing to measure)
//   - never modifies a finding it keeps
export function dropLowConfidenceTolerant(findings, minConfidence) {
  return findings.filter((f) => {
    if (f.severity !== 'tolerant') return true;
    if (!f.region) return true;
    return f.region.confidence >= minConfidence;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/ocrNoiseFilter.test.js`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `node --test 'test/*.test.js'`
Expected: every test passes (this task only adds a new, unused-so-far module).

- [ ] **Step 6: Commit**

```bash
git add src/ocrNoiseFilter.js test/ocrNoiseFilter.test.js
git commit -m "$(cat <<'EOF'
feat(ocr): add dropLowConfidenceTolerant, unwired

A new, narrow module: may remove a tolerant finding when its located
region's confidence is too low to be worth itemizing. Never touches a
material finding at any confidence, never touches a tolerant finding
with no region, never modifies a finding it keeps. compare() and
locateFindings() are both untouched -- this is a new post-processing
step, not a change to either's existing contract.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire it into `verifyPageImage.js`, with the measured threshold

**Files:**
- Modify: `src/verifyPageImage.js`

**Interfaces:**
- Consumes: `dropLowConfidenceTolerant` from Task 2.
- Produces: nothing new — `verifyPageImage()`'s own exported signature is unchanged.

- [ ] **Step 1: Make the change**

In `src/verifyPageImage.js`, change:

```js
import { locateFindings } from './ocrRegions.js';
import { stripOcrFooter } from './ocrFooter.js';
```

to:

```js
import { locateFindings } from './ocrRegions.js';
import { stripOcrFooter } from './ocrFooter.js';
import { dropLowConfidenceTolerant } from './ocrNoiseFilter.js';
```

Add, just below the existing `const MIN_CONFIDENCE = 0.65;` block:

```js
// MEASURED (2026-08-25, real genuine-page data via scripts/ocr-calibrate.mjs's
// criterion 5). Genuine pages' tolerant (name-class) findings clustered at
// two extremes: near-zero confidence (0.000 -- a fully garbled word) or
// 0.820-0.960 (a legitimately read, merely non-material difference). No
// real genuine-page data point fell between them. This sits in that gap,
// with margin on both sides -- the same measured-not-guessed practice as
// MIN_CONFIDENCE and THRESHOLDS.samePageMin.
const MIN_TOLERANT_CONFIDENCE = 0.4;
```

Change:

```js
  const cleanedText = stripOcrFooter(read.text, read.words);
  const report = compare(cleanedText, authText);
  const findings = locateFindings(report.findings, read.words);
  return done({ ...report, findings });
```

to:

```js
  const cleanedText = stripOcrFooter(read.text, read.words);
  const report = compare(cleanedText, authText);
  const located = locateFindings(report.findings, read.words);
  const findings = dropLowConfidenceTolerant(located, MIN_TOLERANT_CONFIDENCE);
  return done({ ...report, findings });
```

- [ ] **Step 2: Run the directly affected suites**

Run: `node --test test/verifyPageImage.test.js test/verifyPageImageEngineFailure.test.js test/appVerifyPageImage.test.js test/appVerifyPageImageEngineError.test.js test/appVerifyPageImageGate.test.js test/ocrRegions.test.js`
Expected: every test passes. (The existing `verifyPageImage.test.js` fixtures don't exercise low-confidence tolerant findings at all — their stub OCR always reports high confidence for whole readings — so this wiring should not change any existing assertion.)

- [ ] **Step 3: Run the whole suite**

Run: `node --test 'test/*.test.js'`
Expected: every test passes.

- [ ] **Step 4: Commit**

```bash
git add src/verifyPageImage.js
git commit -m "$(cat <<'EOF'
feat(ocr): drop low-confidence tolerant findings from the live report

Wires dropLowConfidenceTolerant in after locateFindings, using
MIN_TOLERANT_CONFIDENCE=0.4 -- measured from real genuine-page data
(scripts/ocr-calibrate.mjs's new criterion 5), sitting in the gap
between near-zero-confidence garbled reads and legitimately-read,
merely non-material differences. rep.suppressed needs no adjustment:
it already counted every tolerant finding once (see the earlier
double-count fix), so a dropped finding simply moves from "itemized"
to the same unitemized-noise bucket the word-level fudge term already
occupies.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Verify against real photos, close out the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-08-25-tolerant-finding-confidence-filter-design.md` (status line only)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing — verification-only task.

- [ ] **Step 1: Run the whole suite one more time**

Run: `node --test 'test/*.test.js'`
Expected: every test passes.

- [ ] **Step 2: Run the real-photo calibration one more time**

Run: `node scripts/ocr-calibrate.mjs scripts/print-test-sealed.pdf test/fixtures/pages`

Expected:
- Criterion 1: 10 genuine pages, 0 with material findings (unchanged — this mechanism only ever touches tolerant findings).
- Criterion 4: `1-altered.jpg` still exactly 1 material finding, unchanged.
- Criterion 5, and the main table's `suppressed` column: on `2-genuine.jpg` and `3-genuine-b.jpg` (the two genuine fixtures with a below-threshold entry — the `0.000` reading on `2-genuine.jpg`), the itemized tolerant list is now one entry shorter than before this task, while `suppressed` for that row is unchanged from its pre-Task-3 value (per §3 of the design: the dropped entry moves into the same bucket the word-noise fudge already occupies, not off the books). Confirm this directly by comparing this run's per-row `suppressed` numbers against Task 1 Step 2's run — they must match exactly, row for row.

If any genuine row's `material` count changes, or any `suppressed` number differs from Task 1's run: stop, this mechanism has reached further than intended, investigate before closing this task.

- [ ] **Step 3: Update the spec's status line**

In `docs/superpowers/specs/2026-08-25-tolerant-finding-confidence-filter-design.md`, change:

```markdown
**Status:** Approved design, pre-implementation
```

to:

```markdown
**Status:** Implemented and verified against real photos (2026-08-25) — MIN_TOLERANT_CONFIDENCE=0.4, measured per §4. See the calibration run in Task 4 of the implementation plan.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-25-tolerant-finding-confidence-filter-design.md
git commit -m "$(cat <<'EOF'
docs(ocr): mark the tolerant-finding confidence filter as implemented

Verified against the real committed calibration photos: material
findings and suppressed counts are unchanged row-for-row from before
this task, confirming the filter only ever removes what it's supposed
to -- itemized tolerant findings move into the existing unitemized-
noise bucket, nothing disappears from the report's honesty about what
it found.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
