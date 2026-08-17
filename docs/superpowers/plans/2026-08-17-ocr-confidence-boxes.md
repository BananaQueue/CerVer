# OCR Confidence Boxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw a box on the photo at each finding's location, styled by the underlying OCR word confidence, so a reader can jump straight to the spot instead of hunting the whole page by eye.

**Architecture:** Tesseract already computes a confidence and bounding box per recognized word; `src/ocr.js` currently discards both. A new pure module, `locateFindings()`, runs strictly *after* `pageCompare.compare()` returns and can only enrich an existing finding with a `region` — it cannot create, remove, or reclassify one. The frontend redraws the already-in-memory photo to a canvas and overlays a box per located finding.

**Tech Stack:** Node ESM, `node:test`, tesseract.js (already a dependency), vanilla JS/Canvas 2D on the frontend.

**Spec:** [`docs/superpowers/specs/2026-08-17-ocr-confidence-boxes-design.md`](../specs/2026-08-17-ocr-confidence-boxes-design.md)

## Global Constraints

- **A box's presence never depends on confidence — only its styling does.** `src/pageCompare.js` is not modified by this plan, at all. (Spec §2.)
- **`locateFindings()` fails safe.** No matching run found → the finding gets no `region`, never an error, never a change to its existing fields. (Spec §5.)
- **Findings with `found: null` never get a region** — there is no OCR word to point at. (Spec §5.)
- **A duplicate `found` value appearing twice in `words` must resolve to two different regions**, not the same one twice — consume matched words on use. (Spec §5.)
- **Box color follows the existing severity convention: material = `var(--warn)`, tolerant = `var(--slate)`. Never `var(--ok)`.** (Spec §6, and the base feature's governing rule.)
- **The uploaded photo is still never written to disk or stored in the DB.** Canvas rendering is client-side and transient. (Spec §11.)
- **No test in this plan loads the real OCR engine.** `npm test` stays offline and fast, same as the base feature. Manual verification of the real engine goes through `scripts/ocr-smoke.mjs`, never `node:test`.
- House style: 2-space indent, single quotes, semicolons, ~100 col, ESM.
- Baseline before this plan: `npm test` passes in full (205/205 at time of writing).

---

### Task 1: `recognize()` returns per-word data

**Files:**
- Modify: `src/ocr.js`
- Modify: `scripts/ocr-smoke.mjs`

**Interfaces:**
- Consumes: nothing new — `tesseract.js`'s existing `w.recognize()` call, whose result already carries `data.words` (confirmed via `node_modules/tesseract.js/src/index.d.ts`: `Word { text, confidence, bbox: {x0,y0,x1,y1} }`).
- Produces: `recognize(imageBytes) => Promise<{ text, meanConfidence, wordCount, words }>` where `words` is `Array<{ text: string, confidence: number (0..1), bbox: {x0,y0,x1,y1} }>`. This is **additive** — `text`, `meanConfidence`, `wordCount` are unchanged in meaning and type, so every existing caller keeps working untouched.

There is no `node:test` for this task — `recognize()` needs the real wasm engine, and this codebase's established rule is that `npm test` never loads it (see `src/ocr.js`'s own header comment and the existing `scripts/ocr-smoke.mjs`). Verification here is the smoke script, exactly as the base feature already does for `recognize()` itself.

- [ ] **Step 1: Modify `recognize()` in `src/ocr.js`**

Find the existing function (currently lines 113-127) and replace it with:

```js
export async function recognize(imageBytes) {
  const w = await worker();
  const { data } = await w.recognize(Buffer.from(imageBytes));
  const text = String(data?.text ?? '');
  return {
    text,
    // tesseract reports 0..100; the rest of the app talks in 0..1. Some
    // builds report -1 (still Number.isFinite) when nothing was recognized,
    // so clamp rather than let a blank read report a negative confidence.
    meanConfidence: Number.isFinite(data?.confidence)
      ? Math.min(1, Math.max(0, data.confidence / 100))
      : 0,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    // Per-word confidence and position, for locateFindings() (src/ocrRegions.js)
    // to draw a box at a finding's actual location on the photo. Tesseract
    // already computes this as part of the same recognize() call above --
    // this was simply discarded until now. bbox is passed through unchanged;
    // it's already in the original photo's pixel space, which is what the
    // frontend needs (spec 2026-08-17 §7).
    words: (data?.words ?? []).map((w) => ({
      text: String(w?.text ?? ''),
      confidence: Number.isFinite(w?.confidence)
        ? Math.min(1, Math.max(0, w.confidence / 100))
        : 0,
      bbox: {
        x0: w?.bbox?.x0 ?? 0,
        y0: w?.bbox?.y0 ?? 0,
        x1: w?.bbox?.x1 ?? 0,
        y1: w?.bbox?.y1 ?? 0,
      },
    })),
  };
}
```

- [ ] **Step 2: Extend `scripts/ocr-smoke.mjs` to report word-level data**

Read the current file first — it's short. After the existing `console.log(got.text.slice(0, 400));` line and before the final `---` separator block, add:

```js
console.log(`words with position: ${got.words.length}`);
if (got.words.length > 0) {
  const w = got.words[0];
  console.log(`first word: ${JSON.stringify(w.text)} conf=${w.confidence.toFixed(3)} bbox=${JSON.stringify(w.bbox)}`);
}
```

Place it so the full script reads, in order: confidence/wordCount summary, the new words summary, the `---` separator, the text sample, the `---` separator, then the existing pass/fail check. Match the existing script's exact formatting style rather than introducing a new one.

- [ ] **Step 3: Run the smoke script against a real image**

```bash
node scripts/ocr-smoke.mjs frames/frame-2026-08-11T01-30-11-298Z.png
```

Expected: the existing confidence/text output, PLUS a `words with position: N` line with `N > 0`, and a `first word: ...` line showing real `text`, a `confidence` between 0 and 1, and a `bbox` with four numeric fields. If `words with position: 0` while `wordCount` in the summary above it is nonzero, something is wrong with the `data.words` mapping — stop and investigate before continuing.

- [ ] **Step 4: Confirm the existing suite is unaffected**

```bash
npm test
```

Expected: same pass count as before this task (no test imports `src/ocr.js` directly with the real engine — confirm by checking `grep -rn "from '../src/ocr.js'" test/` finds nothing, matching the base feature's established boundary).

- [ ] **Step 5: Commit**

```bash
git add src/ocr.js scripts/ocr-smoke.mjs
git commit -m "feat(ocr): surface per-word confidence and position, previously discarded"
```

---

### Task 2: `locateFindings()` — pure region-lookup module

**Files:**
- Create: `src/ocrRegions.js`
- Create: `test/ocrRegions.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 directly — this module is independent of `src/ocr.js` and only needs the *shape* Task 1 produces (`words: Array<{text, confidence, bbox}>`), passed in as a plain argument. It also consumes the `Finding` shape `pageCompare.js` already produces: `{ severity, cls, line, expected, found, reason }`.
- Produces: `locateFindings(findings, words) => findings` where each returned finding is either unchanged or has one new key added: `region: { x0, y0, x1, y1, confidence }`.

- [ ] **Step 1: Write the failing tests**

Create `test/ocrRegions.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test test/ocrRegions.test.js
```

Expected: FAIL — `Cannot find module '.../src/ocrRegions.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/ocrRegions.js`:

```js
// Locates each finding's `found` value among the OCR engine's recognized
// words, and attaches a `region` (bounding box + confidence) when found.
//
// Runs strictly AFTER pageCompare.compare() has already decided the findings.
// This module can only ADD a region to an existing finding -- it can never
// create, remove, or change the severity/reason/expected/found of one. A box
// is a location pointer, not a verdict; only its styling depends on
// confidence, and this module doesn't even decide styling, just supplies the
// number the frontend styles with.
//
// See docs/superpowers/specs/2026-08-17-ocr-confidence-boxes-design.md

function normalizeWord(s) {
  return String(s ?? '').toLowerCase().trim();
}

function normalizeTarget(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function unionBbox(a, b) {
  if (!b) return { x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 };
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

// Finds the first not-yet-consumed contiguous run of `words` whose
// concatenated, normalized text equals `target`'s normalized text. Consumes
// the run's indices on success, so a second finding can never claim the same
// words -- this is what makes two identical `found` values resolve to two
// different regions instead of the same one twice.
//
// Returns null on no match. This is the ordinary, expected outcome when OCR
// fragmented a value across a line break or split it unexpectedly -- not an
// error. The caller (locateFindings) treats null exactly like "no region".
function findRun(target, words, consumed) {
  const wantWords = normalizeTarget(target).split(' ').filter(Boolean);
  if (wantWords.length === 0) return null;

  for (let start = 0; start < words.length; start++) {
    if (consumed.has(start)) continue;

    let bbox = null;
    let minConfidence = Infinity;
    const used = [];
    let wi = 0;
    let idx = start;

    while (wi < wantWords.length && idx < words.length && !consumed.has(idx)) {
      const word = words[idx];
      if (normalizeWord(word.text) !== wantWords[wi]) break;
      bbox = unionBbox(word.bbox, bbox);
      minConfidence = Math.min(minConfidence, word.confidence);
      used.push(idx);
      wi++;
      idx++;
    }

    if (wi === wantWords.length) {
      for (const i of used) consumed.add(i);
      return { ...bbox, confidence: minConfidence };
    }
  }
  return null;
}

export function locateFindings(findings, words) {
  const safeWords = Array.isArray(words) ? words : [];
  const consumed = new Set();
  return findings.map((f) => {
    if (f.found === null || f.found === undefined) return { ...f };
    const region = findRun(f.found, safeWords, consumed);
    return region ? { ...f, region } : { ...f };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test test/ocrRegions.test.js
```

Expected: PASS, 8 tests.

If `two findings with the same found value each get a different region` fails with both getting `x0: 0`, the `consumed` set isn't being checked before starting a new run at `start` — check the `if (consumed.has(start)) continue;` line is present and runs before the inner `while`.

- [ ] **Step 5: Run the whole suite**

```bash
npm test
```

Expected: previous count + 8, all passing.

- [ ] **Step 6: Commit**

```bash
git add src/ocrRegions.js test/ocrRegions.test.js
git commit -m "feat(ocr): locate each finding's OCR word span, fail-safe when it can't"
```

---

### Task 3: Wire `locateFindings()` into `verifyPageImage()`

**Files:**
- Modify: `src/verifyPageImage.js`
- Modify: `test/verifyPageImage.test.js`

**Interfaces:**
- Consumes: `locateFindings` from `src/ocrRegions.js` (Task 2); `read.words` from `recognize()`'s new return shape (Task 1).
- Produces: `verifyPageImage(...)`'s `compared` report now has `region` on findings where one was located. Every other status (`no_record_copy`, `image_unreadable`, `page_differs`, `ocr_engine_error`) is unaffected — none of them carry findings with a `found` value to locate.

- [ ] **Step 1: Write the failing test**

Open `test/verifyPageImage.test.js`. Change the `stubOcr` helper (currently lines 31-35) to accept an optional third argument, keeping every existing call site working unchanged:

```js
const stubOcr = (text, meanConfidence = 0.9, words = []) => async () => ({
  text,
  meanConfidence,
  wordCount: text.split(/\s+/).filter(Boolean).length,
  words,
});
```

Then add this test after the existing `'an inflated amount is reported as material'` test:

```js
test('a located finding carries a region; an unlocatable one does not', async () => {
  const { db } = await seed();
  // Real bbox/confidence values aren't needed here -- only that they flow
  // through untouched from recognize()'s shape to the final report.
  const words = 'P50,000.00 is imposed under Section 12 of the rules, and the'
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
```

- [ ] **Step 2: Run the tests to verify the first new one fails**

```bash
node --test test/verifyPageImage.test.js
```

Expected: FAIL on `'a located finding carries a region...'` — `moneyFinding.region` is `undefined` because `verifyPageImage` doesn't call `locateFindings` yet. The second new test should already PASS (there's nothing to locate without words, which is exactly today's behavior) — that's fine, it's here to pin the fail-safe default, not to catch a regression.

- [ ] **Step 3: Wire `locateFindings` into `verifyPageImage`**

In `src/verifyPageImage.js`, add the import at the top:

```js
import { locateFindings } from './ocrRegions.js';
```

Then change the final line (currently `return done(compare(read.text, authText));`) to:

```js
  const report = compare(read.text, authText);
  const findings = locateFindings(report.findings, read.words);
  return done({ ...report, findings });
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test test/verifyPageImage.test.js
```

Expected: PASS, previous count + 2.

- [ ] **Step 5: Run the whole suite**

```bash
npm test
```

Expected: previous count + 2, all passing. Confirm no test file needed changes beyond `test/verifyPageImage.test.js` — `test/appVerifyPageImage.test.js`'s existing three tests never inspect `region` and should be unaffected (they exercise `no_record_copy` and the 400 paths, none of which reach `locateFindings`).

- [ ] **Step 6: Commit**

```bash
git add src/verifyPageImage.js test/verifyPageImage.test.js
git commit -m "feat(ocr): attach a located region to each finding that has one"
```

---

### Task 4: Frontend — draw the photo with confidence-styled boxes

**Files:**
- Modify: `public/app.js`
- Modify: `public/check.css`

**Interfaces:**
- Consumes: the `file` (a `File` object, already held in the existing `onchange` closure) and `rep.findings[].region` from the JSON response (Task 3).
- Produces: no exports — UI only. A `<canvas class="ocr-photo">` is inserted into `#ocrOut` when at least one finding has a `region`.

There is no automated test for `public/` in this codebase (confirmed: no test file imports anything from `public/`). Verification is manual, through the browser preview tools, per this codebase's established practice for frontend tasks.

- [ ] **Step 1: Pass `file` through to `renderOcrReport`**

In `public/app.js`, find the `imgEl.onchange` handler (currently around line 731-747). Change the call:

```js
        renderOcrReport(out, await res.json());
```

to:

```js
        renderOcrReport(out, await res.json(), file);
```

- [ ] **Step 2: Add the box-drawing function**

In `public/app.js`, add this new function directly above `renderOcrReport` (currently around line 758):

```js
// Provisional, like every other confidence-derived threshold in this feature
// (THRESHOLDS in src/pageCompare.js, MIN_CONFIDENCE in src/verifyPageImage.js)
// -- awaiting Task 8's calibration against real photographs. Below this, a
// box is drawn solid and heavier; above it, lighter/dashed. Getting this
// number wrong costs a box styled slightly off, never a wrong finding --
// styling is downstream of a finding that already exists (spec 2026-08-17 §2).
const BOX_CONFIDENCE_FLOOR = 0.5;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Draws the uploaded photo into a canvas inside `out`, with one box per
// located finding. Severity decides color (material=--warn, tolerant=--slate
// -- NEVER --ok, same rule as the rest of this feature); region.confidence
// decides weight/dash only. A finding with no `region` draws nothing here --
// it's still in the list below, just without a box (spec §5, §10).
function drawPhotoWithBoxes(out, file, findings) {
  const located = findings.filter((f) => f.region);
  if (!file || located.length === 0) return;

  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.className = 'ocr-photo';
    const maxWidth = out.clientWidth || 600;
    const scale = Math.min(1, maxWidth / img.naturalWidth);
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);

    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const warn = cssVar('--warn');
    const slate = cssVar('--slate');
    for (const f of located) {
      const r = f.region;
      ctx.strokeStyle = f.severity === 'material' ? warn : slate;
      const solid = r.confidence < BOX_CONFIDENCE_FLOOR;
      ctx.lineWidth = solid ? 3 : 1.5;
      ctx.setLineDash(solid ? [] : [5, 3]);
      ctx.strokeRect(r.x0 * scale, r.y0 * scale, (r.x1 - r.x0) * scale, (r.y1 - r.y0) * scale);
    }

    out.prepend(canvas);
    URL.revokeObjectURL(url);
  };
  img.src = url;
}
```

- [ ] **Step 3: Call it from `renderOcrReport`**

Find `renderOcrReport(out, rep)` (currently line 758) and change its signature to accept the file:

```js
function renderOcrReport(out, rep, file) {
```

At the very end of the function, after the existing `out.innerHTML = head + rest;` line, add:

```js
  if (rep.findings) drawPhotoWithBoxes(out, file, rep.findings);
```

This must come AFTER `out.innerHTML = head + rest;` — setting `innerHTML` wipes any child nodes already in `out`, including a canvas that had been prepended by an earlier call.

- [ ] **Step 4: Add minimal CSS for the canvas**

In `public/check.css`, near the existing `.ocr-note` rules, add:

```css
.ocr-photo {
  display: block;
  max-width: 100%;
  margin: 0 0 0.7rem;
  border: 1px solid var(--rule);
  border-radius: 3px;
}
```

`--rule` is already defined at `public/check.css:17` (`#c9d0c6`) — the same border color `.report`/`.ocr-note` already use, so this stays visually consistent with the rest of the report.

- [ ] **Step 5: Verify in the browser**

Use the preview tools (never Bash) to start the dev server with `CERVER_PAGE_IMAGE_OCR=1` set, since the whole feature is gated off otherwise. Reach a verified page result and attach a real photo — a genuine phone-photographed page of a sealed document works better here than a synthetic image, since the point is to see real bounding boxes at real positions.

1. Confirm the photo renders inside the report area.
2. Confirm at least one box appears at a plausible location for a reported finding (material amber `--warn` or tolerant `--slate`, matching that finding's severity — check dev tools' computed style if the visual color is ambiguous).
3. Confirm the box is styled differently (solid+heavier vs. dashed+lighter) depending on whether the underlying word confidence was below `BOX_CONFIDENCE_FLOOR` — this may require testing with more than one photo if a single capture doesn't produce both cases.
4. Confirm a finding with `reason: 'missing'` (no `found` value) shows in the list with no corresponding box, and does not crash rendering.
5. `read_console_messages` — no errors.
6. Screenshot the result as evidence.

- [ ] **Step 6: Run the whole suite**

```bash
npm test
```

Expected: unchanged from Task 3's count — this task touches no test files.

- [ ] **Step 7: Commit**

```bash
git add public/app.js public/check.css
git commit -m "feat(ui): draw the photo with a box at each finding's location"
```

---

### Task 5: Frontend — click a finding to highlight its box

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: the `located` findings array and `canvas`/`ctx` state from Task 4's `drawPhotoWithBoxes`.
- Produces: no exports — UI only.

- [ ] **Step 1: Give each finding row a way to identify its region**

In `public/app.js`, find the `row` function inside `renderOcrReport` (currently around line 784-790). It currently returns an `<li>` with no identifying attribute. Change it to accept an index and tag the row:

```js
  const row = (f, i) => {
    const where = f.line ? `line ${f.line}` : 'not on the record page';
    const said = f.expected === null
      ? `the photo has <b>${esc(f.found)}</b>, the record has no such ${esc(f.cls)}`
      : `record <b>${esc(f.expected)}</b> · photo <b>${esc(f.found ?? 'nothing')}</b>`;
    const attr = f.region ? ` data-region-index="${i}" tabindex="0" style="cursor:pointer"` : '';
    return `<li${attr}><span class="pill" style="background:var(--slate)">${esc(f.cls)}</span> ${said} <span style="color:var(--muted)">(${esc(where)})</span></li>`;
  };
```

`i` here must be the finding's index within the full `located` array `drawPhotoWithBoxes` builds — not its index within `material`/`tolerant` separately, since those are two different arrays today. To keep the numbering consistent between the list and the canvas, look up each finding's position in a shared `located` array rather than threading a separate index through two different `.map()` calls.

`renderOcrReport` currently has, in this order: `const material = rep.findings.filter(...)`, `const tolerant = rep.findings.filter(...)`, then the `row` function, then the `head`/`rest` template literals that call `material.map(row)` and `tolerant.map(row)`. Keep `material` and `tolerant` exactly as they are — both are still used below to build `head` and `rest`. Add `located` alongside them and replace only the `row` function, so the block reads:

```js
  const material = rep.findings.filter((f) => f.severity === 'material');
  const tolerant = rep.findings.filter((f) => f.severity === 'tolerant');
  const located = rep.findings.filter((f) => f.region);

  const row = (f) => {
    const where = f.line ? `line ${f.line}` : 'not on the record page';
    const said = f.expected === null
      ? `the photo has <b>${esc(f.found)}</b>, the record has no such ${esc(f.cls)}`
      : `record <b>${esc(f.expected)}</b> · photo <b>${esc(f.found ?? 'nothing')}</b>`;
    const idx = located.indexOf(f);
    const attr = idx !== -1 ? ` data-region-index="${idx}" tabindex="0" style="cursor:pointer"` : '';
    return `<li${attr}><span class="pill" style="background:var(--slate)">${esc(f.cls)}</span> ${said} <span style="color:var(--muted)">(${esc(where)})</span></li>`;
  };
```

Nothing else in this block changes — `head`'s and `rest`'s existing `material.map(row)` / `tolerant.map(row)` calls stay exactly as they are today; `row` just now also tags whichever findings have a region.

- [ ] **Step 2: Make `drawPhotoWithBoxes` support re-highlighting, and expose a way to trigger it**

Replace `drawPhotoWithBoxes` entirely with this version, which separates "draw everything" from "redraw with one box emphasized" and wires up click/keyboard activation on the rows created in Step 1:

```js
// Provisional, like every other confidence-derived threshold in this feature
// (THRESHOLDS in src/pageCompare.js, MIN_CONFIDENCE in src/verifyPageImage.js)
// -- awaiting Task 8's calibration against real photographs. Below this, a
// box is drawn solid and heavier; above it, lighter/dashed. Getting this
// number wrong costs a box styled slightly off, never a wrong finding --
// styling is downstream of a finding that already exists (spec 2026-08-17 §2).
const BOX_CONFIDENCE_FLOOR = 0.5;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawBox(ctx, f, scale, { emphasize = false } = {}) {
  const r = f.region;
  const warn = cssVar('--warn');
  const slate = cssVar('--slate');
  ctx.strokeStyle = f.severity === 'material' ? warn : slate;
  const solid = r.confidence < BOX_CONFIDENCE_FLOOR;
  ctx.lineWidth = emphasize ? 4 : solid ? 3 : 1.5;
  ctx.setLineDash(emphasize ? [] : solid ? [] : [5, 3]);
  ctx.strokeRect(r.x0 * scale, r.y0 * scale, (r.x1 - r.x0) * scale, (r.y1 - r.y0) * scale);
}

// Draws the uploaded photo into a canvas inside `out`, with one box per
// located finding, and wires each list row (tagged with data-region-index in
// renderOcrReport's `row`) to re-draw with its own box emphasized on click or
// Enter/Space. A finding with no `region` draws nothing here -- it's still in
// the list below, just without a box (spec §5, §10).
function drawPhotoWithBoxes(out, file, located) {
  if (!file || located.length === 0) return;

  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.className = 'ocr-photo';
    const maxWidth = out.clientWidth || 600;
    const scale = Math.min(1, maxWidth / img.naturalWidth);
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');

    const redraw = (emphasizeIndex) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      located.forEach((f, i) => drawBox(ctx, f, scale, { emphasize: i === emphasizeIndex }));
    };
    redraw(-1);
    out.prepend(canvas);
    URL.revokeObjectURL(url);

    const activate = (idx) => {
      redraw(idx);
      canvas.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    out.querySelectorAll('[data-region-index]').forEach((li) => {
      const idx = Number(li.getAttribute('data-region-index'));
      li.addEventListener('click', () => activate(idx));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(idx); }
      });
    });
  };
  img.src = url;
}
```

- [ ] **Step 3: Update the call site in `renderOcrReport`**

Change the final line added in Task 4 (`if (rep.findings) drawPhotoWithBoxes(out, file, rep.findings);`) to pass the already-computed `located` array instead of filtering again:

```js
  if (located.length) drawPhotoWithBoxes(out, file, located);
```

- [ ] **Step 4: Verify in the browser**

With the same setup as Task 4's manual verification:

1. Attach a photo that produces at least two located findings.
2. Click a row in the findings list. Confirm: the canvas scrolls into view, and that finding's box is redrawn thicker/solid while the others stay at their normal styling.
3. Click a different row. Confirm the emphasis moves to the new box and the previous one returns to normal (not both emphasized at once).
4. Tab to a row via keyboard and press Enter or Space. Confirm the same behavior as a click.
5. Click a row with no `data-region-index` (a finding with no region, e.g. a `missing` one) — confirm nothing breaks; it's a plain `<li>` with no click handler.
6. `read_console_messages` — no errors.
7. Screenshot the emphasized state as evidence.

- [ ] **Step 5: Run the whole suite**

```bash
npm test
```

Expected: unchanged from Task 4's count.

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat(ui): clicking a finding highlights its box on the photo"
```
