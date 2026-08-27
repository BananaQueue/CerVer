# Record Line-Preserving Extraction (Comparison-Only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the OCR page-image comparison path a record-side text extraction that preserves real PDF line breaks, so the name-token comparison no longer needs an arbitrary word-count cap to avoid merging separate printed title lines.

**Architecture:** `src/pdfTools.js` gets a new, non-exported `getPageItems(bytes)` helper that both `extractPageTexts` (unchanged output, still feeds the sealing digest) and a new `extractPageTextsWithLines` (comparison-only) build on — the only difference is whether items are joined with `' '` or, per pdf.js's own `item.hasEOL` flag, `'\n'`. `src/verifyPageImage.js` switches its one call site to the new function. `src/pageCompare.js`'s name-token pattern reverts to unbounded now that real line boundaries do the job the 6-word cap used to stand in for.

**Tech Stack:** Node.js, `pdfjs-dist` (already a dependency, already used by `pdfTools.js`), `node:test`.

**Spec:** [docs/superpowers/specs/2026-08-25-record-line-preserving-extraction-design.md](../specs/2026-08-25-record-line-preserving-extraction-design.md)

## Global Constraints

- `extractPageTexts()`'s output, signature, and every existing caller (`src/sealer.js`, `src/docVerifier.js`, `src/app.js`) must not change in any way — it feeds the sealing digest.
- `src/sealCode.js`'s `stripFooter()` / `FOOTER_RE` must not be modified.
- `getPageItems` must not be exported from `src/pdfTools.js` — `extractPageTextsWithLines` is the only sanctioned way to get line-aware record text.
- `isWrapPrefix` in `src/pageCompare.js` (added 2026-08-24) must be kept, unchanged — it is the accepted backstop for residual PDF-vs-print wrap mismatches, per the spec's §4.
- Tests are run from the repo root: `node --test 'test/*.test.js'`.

---

### Task 1: `pdfTools.js` — shared item-loading helper + the new line-preserving extraction

**Files:**
- Modify: `src/pdfTools.js`
- Create: `test/pdfTools.test.js`

**Interfaces:**
- Produces: `extractPageTextsWithLines(bytes: Buffer) => Promise<string[]>` — same page indexing as `extractPageTexts` (index 0 = page 1), each page's text with `\n` where pdf.js reports `hasEOL`, `' '` otherwise.
- Consumes: nothing new — `pdfjs-dist/legacy/build/pdf.mjs`, already imported by this file today.

- [ ] **Step 1: Write the failing/regression tests**

Create `test/pdfTools.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify the new-function ones fail**

Run: `node --test test/pdfTools.test.js`
Expected: the byte-for-byte `extractPageTexts` test PASSES (nothing has changed yet); both `extractPageTextsWithLines` tests FAIL with `extractPageTextsWithLines is not a function` (or a named-export import error).

- [ ] **Step 3: Refactor `pdfTools.js`**

Replace the full contents of `src/pdfTools.js` with:

```js
import { PDFDocument } from 'pdf-lib';

// Shared PDF-load/iterate step behind both extraction functions below. Not
// exported: extractPageTextsWithLines is the one sanctioned way to get
// line-aware record text (see docs/superpowers/specs/
// 2026-08-25-record-line-preserving-extraction-design.md).
async function getPageItems(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = Uint8Array.from(bytes); // copy — pdfjs may detach the buffer
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true })
    .promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items);
  }
  await pdf.cleanup();
  return pages;
}

// Extract the text of every page. Returns an array; index 0 = page 1.
// Feeds the sealing digest (src/sealer.js) and every other caller — output
// is unchanged from before the getPageItems refactor, verified in
// test/pdfTools.test.js.
export async function extractPageTexts(bytes) {
  const pages = await getPageItems(bytes);
  return pages.map((items) => items.map((x) => x.str).join(' '));
}

// Same pages, same indexing, but keeps real line breaks: pdf.js reports
// item.hasEOL when an item is immediately followed by a line break in the
// PDF's own text flow. Comparison-only (src/verifyPageImage.js) — never
// used for sealing. See docs/superpowers/specs/
// 2026-08-25-record-line-preserving-extraction-design.md.
export async function extractPageTextsWithLines(bytes) {
  const pages = await getPageItems(bytes);
  return pages.map((items) => {
    let out = '';
    items.forEach((item, i) => {
      out += item.str;
      if (i < items.length - 1) out += item.hasEOL ? '\n' : ' ';
    });
    return out;
  });
}

// Extract a single page (1-based) into its own one-page PDF, for staff preview.
export async function extractSinglePage(bytes, k) {
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const [pg] = await out.copyPages(src, [k - 1]);
  out.addPage(pg);
  return out.save();
}
```

- [ ] **Step 4: Run the tests to verify they all pass**

Run: `node --test test/pdfTools.test.js`
Expected: 3 pass, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `node --test 'test/*.test.js'`
Expected: every existing test still passes (this task only adds an export; nothing existing imports or behaves differently yet).

- [ ] **Step 6: Commit**

```bash
git add src/pdfTools.js test/pdfTools.test.js
git commit -m "$(cat <<'EOF'
feat(ocr): add a line-preserving record extraction, comparison-only

extractPageTexts() must keep flattening every page to one space-joined
string -- it feeds the sealing digest, and a digest can't depend on a
decision about where lines "should" go. But pdf.js already reports
item.hasEOL per text item, and the OCR page-image comparison path has
never had that information on the record side, only the photo side.

extractPageTextsWithLines() is a new, comparison-only sibling built on
a shared getPageItems() helper: same pages, same indexing, joined with
real line breaks instead of always a space. extractPageTexts()'s own
output is unchanged, verified byte-for-byte against a real calibration
PDF.

See docs/superpowers/specs/2026-08-25-record-line-preserving-extraction-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire `verifyPageImage.js` to the new extraction

**Files:**
- Modify: `src/verifyPageImage.js:2` (import), `src/verifyPageImage.js:51` (call site)

**Interfaces:**
- Consumes: `extractPageTextsWithLines` from Task 1 (`src/pdfTools.js`).
- Produces: nothing new — `verifyPageImage()`'s own exported signature is unchanged.

- [ ] **Step 1: Make the change**

In `src/verifyPageImage.js`, change:

```js
import { extractPageTexts } from './pdfTools.js';
```

to:

```js
import { extractPageTextsWithLines } from './pdfTools.js';
```

and change:

```js
    authText = (await extractPageTexts(bytes))[k - 1];
```

to:

```js
    authText = (await extractPageTextsWithLines(bytes))[k - 1];
```

- [ ] **Step 2: Run the directly affected suites**

Run: `node --test test/verifyPageImage.test.js test/verifyPageImageEngineFailure.test.js test/appVerifyPageImage.test.js test/appVerifyPageImageEngineError.test.js test/appVerifyPageImageGate.test.js`
Expected: every test passes. (`test/fixtures/make-pdf.js`'s `makePdf` already draws each body sentence as its own line specifically so pdf.js doesn't silently drop text that runs past the page edge — see the comment at the top of `test/verifyPageImage.test.js` — so these bodies already have real per-sentence `hasEOL` boundaries; switching the record side to preserve them should make the existing "compares clean" assertions hold *more* exactly, not break them. Confirm this rather than assume it.)

- [ ] **Step 3: Run the whole suite**

Run: `node --test 'test/*.test.js'`
Expected: every test passes.

- [ ] **Step 4: Commit**

```bash
git add src/verifyPageImage.js
git commit -m "$(cat <<'EOF'
feat(ocr): use the line-preserving extraction for page-image comparison

The one call site that should ever see real record-side line breaks.
Every other extractPageTexts() caller (sealer.js's digest, docVerifier.js,
app.js's control-number lookup) is untouched.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Remove the 6-word name cap, now redundant (and potentially wrong)

**Files:**
- Modify: `src/pageCompare.js` (the `name` entry in `TOKEN_PATTERNS`)
- Modify: `test/pageCompare.test.js` (the title-merge test)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — `extractTokens`'s exported signature and every other token class are unchanged.

- [ ] **Step 1: Update the test to exercise real line-broken input**

In `test/pageCompare.test.js`, find:

```js
// A record page's text has no line breaks at all (extractPageTexts flattens
// the whole page into one string) -- unlike a photo's OCR reading, which
// keeps real ones. Left unbounded, the name pattern greedily spans across
// what were genuinely two separate printed title lines whenever they're
// both ALL-CAPS and land adjacent in that flattened text, merging two real
// names into one token the photo side never produces -- reported live
// 2026-08-24 as a false "difference" on an untampered page: the record's
// merged "DEPARTMENT OF ENVIRONMENT AND NATURAL RESOURCES ENVIRONMENTAL
// MANAGEMENT BUREAU" against the photo's correctly-separate two names.
// Capped at 6 words, the longest genuine single name observed in this
// project's real documents ("DEPARTMENT OF ENVIRONMENT AND NATURAL
// RESOURCES") -- a heuristic bound from observed data, not a rule from a
// document standard, and worth revisiting if a longer legitimate single
// name is ever found to be wrongly split by it.
test('extractTokens does not merge two adjacent printed title lines into one name', () => {
  const t = extractTokens('DEPARTMENT OF ENVIRONMENT AND NATURAL RESOURCES ENVIRONMENTAL MANAGEMENT BUREAU');
  assert.deepEqual(byClass(t, 'name'), [
    'DEPARTMENT OF ENVIRONMENT AND NATURAL RESOURCES',
    'ENVIRONMENTAL MANAGEMENT BUREAU',
  ]);
});
```

Replace it with:

```js
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
```

- [ ] **Step 2: Run the test to verify it now fails**

Run: `node --test test/pageCompare.test.js`
Expected: this one test FAILS — the cap is still in place, so `extractTokens` currently reports the record-side value capped at 6 words (`'DEPARTMENT OF ENVIRONMENT AND NATURAL RESOURCES'` only, no second entry) rather than genuinely stopping at the new `\n`. (It happens to still assert the right thing for this particular 6-word title, so check the actual failure — if it unexpectedly passes, inspect why before continuing; the cap and the real boundary coincide at exactly 6 words here, so a pass at this step is possible and is not a sign of a broken test, but confirm the *next* step's regex change is what's doing the work, not a coincidence.)

- [ ] **Step 3: Remove the cap**

In `src/pageCompare.js`, find:

```js
  // Capped at 6 words total (1 + up to 5 more) -- unbounded, this spans
  // across what were genuinely two separate printed title lines whenever
  // the record's flattened, line-break-free text puts them adjacent and
  // both are ALL-CAPS. 6 is the longest genuine single name observed in
  // this project's real documents ("DEPARTMENT OF ENVIRONMENT AND NATURAL
  // RESOURCES"); see test/pageCompare.test.js for the real case this fixes.
  ['name', new RegExp(String.raw`\b[A-Z][A-Z&.'-]+(?:\s+[A-Z][A-Z&.'-]+){1,5}\b`, 'g')],
```

Replace it with:

```js
  // Real line boundaries (src/pdfTools.js's extractPageTextsWithLines,
  // wired in via src/verifyPageImage.js) are what stop a name run now, not
  // a word count. A fixed 6-word cap used to stand in for that boundary and
  // is removed: keeping it alongside real line info would be actively
  // wrong, not just redundant -- it would wrongly truncate any genuine
  // single printed line naming something longer than 6 words. See
  // docs/superpowers/specs/2026-08-25-record-line-preserving-extraction-design.md.
  ['name', new RegExp(String.raw`\b[A-Z][A-Z&.'-]+(?:\s+[A-Z][A-Z&.'-]+)+\b`, 'g')],
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/pageCompare.test.js`
Expected: all tests pass, including the updated title-merge test and the existing wrap-prefix test (`'a title split across a real printed line-wrap is not reported as a camera-noise difference'`), which already used real `\n`-joined input and needs no change.

- [ ] **Step 5: Run the whole suite**

Run: `node --test 'test/*.test.js'`
Expected: every test passes.

- [ ] **Step 6: Commit**

```bash
git add src/pageCompare.js test/pageCompare.test.js
git commit -m "$(cat <<'EOF'
feat(ocr): remove the 6-word name cap, now that real lines do its job

The record side gets real line breaks now (extractPageTextsWithLines,
previous commit), so the boundary that stops a name run is a real '\n'
on both sides, symmetrically -- not a word count standing in for one.
Keeping the cap alongside real line info would be actively wrong: it
would wrongly truncate a genuine single printed line naming something
longer than 6 words. isWrapPrefix (2026-08-24) is kept, unchanged, as
the backstop for residual PDF-vs-print wrap mismatches.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Verify against real photos, close out the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-08-25-record-line-preserving-extraction-design.md` (status line only)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing — this is a verification-only task.

- [ ] **Step 1: Run the whole suite one more time**

Run: `node --test 'test/*.test.js'`
Expected: every test passes.

- [ ] **Step 2: Run the real-photo calibration**

Run: `node scripts/ocr-calibrate.mjs scripts/print-test-sealed.pdf test/fixtures/pages`
Expected, matching every prior calibration run this session:
- Criterion 1: all genuine-labelled pages, 0 with material findings.
- Criterion 4: `1-altered.jpg` still reports exactly 1 material finding (the known `R1-2026-010734 -> R1-2026-010784` reference alteration).
- No new material findings on any genuine page, and no unexplained change in the `suppressed` column that isn't a clear reduction (fewer or equal tolerant "camera noise" entries than before this plan, never more) — if `suppressed` goes *up* on any genuine page, stop and investigate before closing this task; that would mean the line-preserving extraction introduced a new mismatch rather than removing one.

- [ ] **Step 3: Update the spec's status line**

In `docs/superpowers/specs/2026-08-25-record-line-preserving-extraction-design.md`, change:

```markdown
**Status:** Approved design, pre-implementation
```

to:

```markdown
**Status:** Implemented and verified against real photos (2026-08-25) — see the calibration run in Task 4 of the implementation plan.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-25-record-line-preserving-extraction-design.md
git commit -m "$(cat <<'EOF'
docs(ocr): mark the line-preserving extraction design as implemented

Verified against the real committed calibration photos: genuine pages
still show zero material findings, the known alteration is still
caught, and tolerant "camera noise" counts did not increase.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
