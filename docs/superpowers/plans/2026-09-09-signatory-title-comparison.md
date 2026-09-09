# Signatory Title Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implemented 2026-09-09, all three tasks complete. Task 3's
extraction boundary needed real revision, exactly as this plan's own
Global Constraints anticipated — see the design doc's own updated Status
for the full trail. One deliberate deviation from Task 3 Step 4 as
written: rather than add a real-Tesseract-calling test into
`test/pageCompare.test.js`, the calibration script was kept as a
permanent, committed script (`scripts/calibrate-signatory-title.mjs`)
instead — checking `test/ocr.test.js` and `test/verifyPageImage.test.js`
first showed neither actually calls real OCR as part of `npm test` (both
stub it); every real-photo check in this project already lives in a
standalone script (`scripts/ocr-calibrate.mjs`), kept out of the fast
suite since OCR is slow. Following that established convention instead
of the plan's literal step.

**Goal:** Extract and compare the free-text title/position block that follows a signatory's printed name, so a substitution there (the real case found 2026-09-09: a full title collapsed to a bare "Regional Director") is caught as a material finding instead of producing no finding at all.

**Architecture:** A new `signatoryTitle` class in `src/pageCompare.js`, anchored on the last already-extracted `name`-class token (the signatory's printed name) and bounded by the first blank line after it. Extracted identically on both record and photo text via the same function `extractTokens` already calls for every other class. Compared by a dedicated pass (`compareSignatoryTitle`, mirroring `compareNumberedItems`) rather than the generic key-based passes, since there is at most one signatory per document — no repeatable key to pair on.

**Tech Stack:** Plain JS, Node's built-in `node:test`, Tesseract via the existing `src/ocr.js`.

**Spec:** `docs/superpowers/specs/2026-09-09-signatory-title-comparison-design.md`

## Global Constraints

- Extraction runs identically on both sides (no record-driven label-guidance for v1 — only fall back to that, per the spec §3/§5, if Task 3's real-photo calibration shows the blank-line boundary fails on noisy OCR text).
- `signatoryTitle` is NOT added to `STRICT` — it carries no digits, so the digit rule doesn't apply; materiality is decided by word-level similarity instead.
- The similarity threshold (`SIGNATORY_TITLE_SIMILARITY_FLOOR`) starts as a provisional, reasoned guess and MUST be revisited with real measured values during Task 3 — do not treat the Task 2 value as final.
- Every real-photo criterion in the design spec's §7 must pass before this plan is considered done — Task 3 is not optional polish, it's the verification the first two tasks' correctness depends on.

---

## Task 1: Extraction

**Files:**
- Modify: `src/pageCompare.js` (new function `extractSignatoryTitleToken`, wired into `extractTokens`)
- Test: `test/pageCompare.test.js`

**Interfaces:**
- Produces: `extractSignatoryTitleToken(rawLines: string[], nameTokens: {cls, value, line}[]): {cls: 'signatoryTitle', value: string, line: number} | null` — a module-internal (not exported) function, exercised through `extractTokens`.
- Consumes: nothing new — `stripFooter` (already in this file).

- [x] **Step 1: Write the failing tests**

Add to `test/pageCompare.test.js`, near the other extraction tests (after the `extractTokens finds control numbers and citations` test around line 128):

```js
test('extractTokens finds a signatory title following the signer\'s printed name', () => {
  const text = [
    'MS. MA. ISABEL O. PEREZ-MAMARADLO',
    'Supervising Environmental Management Specialist,',
    'Chief, Environmental Impact Assessment Section',
    'In-Charge, Office of the Regional Director',
  ].join('\n');
  const t = extractTokens(text);
  assert.deepEqual(byClass(t, 'signatoryTitle'), [
    'Supervising Environmental Management Specialist, Chief, Environmental Impact Assessment Section In-Charge, Office of the Regional Director',
  ]);
});

test('extractTokens finds a single-line signatory title (a different real document shape)', () => {
  const text = 'NOEL A. VILLANUEVA, CESO IV\nRegional Director';
  const t = extractTokens(text);
  assert.deepEqual(byClass(t, 'signatoryTitle'), ['Regional Director']);
});

test('a title block stops at the first blank line, not at end of text', () => {
  const text = [
    'MS. MA. ISABEL O. PEREZ-MAMARADLO',
    'Regional Director',
    '',
    'Page 1 of 1',
  ].join('\n');
  const t = extractTokens(text);
  assert.deepEqual(byClass(t, 'signatoryTitle'), ['Regional Director']);
});

test('a title block runs to end of text when no blank line follows', () => {
  const text = 'MS. MA. ISABEL O. PEREZ-MAMARADLO\nRegional Director';
  const t = extractTokens(text);
  assert.deepEqual(byClass(t, 'signatoryTitle'), ['Regional Director']);
});

test('no name token means no signatory title, even with title-shaped prose present', () => {
  const t = extractTokens('Supervising Environmental Management Specialist,\nChief, Environmental Impact Assessment Section');
  assert.deepEqual(byClass(t, 'signatoryTitle'), []);
});

test('a name token with nothing but a blank line after it extracts no signatory title', () => {
  const t = extractTokens('MS. MA. ISABEL O. PEREZ-MAMARADLO\n\nPage 1 of 1');
  assert.deepEqual(byClass(t, 'signatoryTitle'), []);
});

// Real regression risk: the SUBJECT line and other ALL-CAPS prose earlier
// in a document also match the `name` pattern. The anchor must be the
// LAST such token, not the first, or a signatory title would be extracted
// starting from the wrong place entirely.
test('the signatory anchor is the LAST name token, not an earlier ALL-CAPS run', () => {
  const text = [
    'SUBJECT : AUTHORIZING THE ATTENDANCE OF EMB-I PERSONNEL',
    'Some body text about the order goes here for context.',
    'MS. MA. ISABEL O. PEREZ-MAMARADLO',
    'Regional Director',
  ].join('\n');
  const t = extractTokens(text);
  assert.deepEqual(byClass(t, 'signatoryTitle'), ['Regional Director']);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node --test test/pageCompare.test.js`
Expected: FAIL — all 7 new tests fail (`byClass(t, 'signatoryTitle')` returns `[]` for every case, since nothing extracts this class yet).

- [x] **Step 3: Implement extraction**

In `src/pageCompare.js`, add near `extractFieldTokens` (both are "runs last, uses what earlier classes already found" functions):

```js
// A signatory's printed name followed by an unstructured title/position
// block -- see docs/superpowers/specs/2026-09-09-signatory-title-comparison-design.md.
// Anchored on the LAST `name`-class token by line number (the signatory's
// own printed name in both real documents checked in the design doc's §2)
// -- an earlier ALL-CAPS run, like a SUBJECT line, must never be mistaken
// for the anchor. Bounded by the first blank line after the anchor, or end
// of text. Unlike every other extraction function in this file, this one
// consumes already-extracted tokens (nameTokens) rather than deriving
// everything from raw text alone -- it has to run after the TOKEN_PATTERNS
// loop that produces them.
function extractSignatoryTitleToken(rawLines, nameTokens) {
  if (nameTokens.length === 0) return null;
  const anchorLine = Math.max(...nameTokens.map((t) => t.line));
  const titleLines = [];
  for (let i = anchorLine; i < rawLines.length; i++) {
    const line = stripFooter(rawLines[i]).trim();
    if (line === '') break;
    titleLines.push(line);
  }
  if (titleLines.length === 0) return null;
  return { cls: 'signatoryTitle', value: titleLines.join(' '), line: anchorLine + 1 };
}
```

Wire it into `extractTokens`, right before the final `return`:

```js
  out.push(...extractFieldTokens(text, claimed, opts.fieldLabels));

  // Last of all -- needs the `name` tokens already produced above as its anchor.
  const signatoryTitle = extractSignatoryTitleToken(rawLines, out.filter((t) => t.cls === 'name'));
  if (signatoryTitle) out.push(signatoryTitle);

  return out.sort((a, b) => a.line - b.line);
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node --test test/pageCompare.test.js`
Expected: PASS, all 7 new tests, no regressions in the rest of the file.

- [x] **Step 5: Commit**

```bash
git add src/pageCompare.js test/pageCompare.test.js
git commit -m "$(cat <<'EOF'
feat(ocr): extract a signatory's title block as a signatoryTitle token

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Comparison and wiring

**Files:**
- Modify: `src/pageCompare.js` (`keyFor`, new `compareSignatoryTitle`, `compare()`)
- Test: `test/pageCompare.test.js`

**Interfaces:**
- Consumes: `extractSignatoryTitleToken` (Task 1, via `extractTokens`), `keyFor`, `similarity` (both already in this file).
- Produces: `compareSignatoryTitle(authTokens, ocrTokens): { findings: Finding[], suppressed: number }`.

- [x] **Step 1: Write the failing tests**

Add to `test/pageCompare.test.js`, near the citation tests added 2026-09-09 (after the `compare` import is already in scope, around line 1300+):

```js
const SIGNER_LINES = [
  'MS. MA. ISABEL O. PEREZ-MAMARADLO',
  'Supervising Environmental Management Specialist,',
  'Chief, Environmental Impact Assessment Section',
  'In-Charge, Office of the Regional Director',
];

test('a matching signatory title (minor OCR noise) is not a finding', () => {
  const auth = [...SIGNER_LINES].join('\n');
  const ocr = [
    'MS. MA. ISABEL O. PEREZ-MAMARADLO',
    'Supervising Environmental Management Speciaiist,', // one noisy letter
    'Chief, Environmental Impact Assessment Section',
    'In-Charge, Office of the Regional Director',
  ].join('\n');
  const r = compare(ocr, auth);
  assert.deepEqual(materials(r).filter((f) => f.cls === 'signatoryTitle'), []);
});

// The real case, 2026-09-09: a genuine altered sheet kept the signer's
// name and replaced the entire title with a bare "Regional Director".
test('a genuinely replaced signatory title is material', () => {
  const auth = [...SIGNER_LINES].join('\n');
  const ocr = 'MS. MA. ISABEL O. PEREZ-MAMARADLO\nRegional Director';
  const r = compare(ocr, auth);
  const f = materials(r).find((x) => x.cls === 'signatoryTitle');
  assert.ok(f, 'expected a signatoryTitle finding');
  assert.equal(f.reason, 'text');
  assert.equal(f.found, 'Regional Director');
});

test('record has a signatory title, photo has none -- tolerant, not material', () => {
  const auth = [...SIGNER_LINES].join('\n');
  const ocr = 'Some unrelated line with no ALL-CAPS name in it at all here.';
  const r = compare(ocr, auth);
  assert.deepEqual(materials(r).filter((f) => f.cls === 'signatoryTitle'), []);
  const tol = r.findings.find((f) => f.cls === 'signatoryTitle');
  assert.ok(tol, 'expected a tolerant signatoryTitle finding');
  assert.equal(tol.severity, 'tolerant');
  assert.equal(tol.reason, 'missing');
});

test('photo has a signatory title, record has none -- no finding either way', () => {
  const auth = 'Some unrelated line with no ALL-CAPS name in it at all here.';
  const ocr = 'MS. MA. ISABEL O. PEREZ-MAMARADLO\nRegional Director';
  const r = compare(ocr, auth);
  assert.deepEqual(r.findings.filter((f) => f.cls === 'signatoryTitle'), []);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node --test test/pageCompare.test.js`
Expected: FAIL — `compare()` produces no `signatoryTitle` findings at all yet (the generic passes don't know this class, and there is no dedicated comparison function).

- [x] **Step 3: Implement comparison**

In `src/pageCompare.js`, extend `keyFor` (the existing fold branch, so `signatoryTitle` gets the same glyph/letter-noise forgiveness `name`/`field`/`listItem`/`numberedItem` already have):

```js
  if (cls === 'name' || cls === 'field' || cls === 'listItem' || cls === 'numberedItem' || cls === 'signatoryTitle') return foldLetterNoise(foldedCase);
```

Add the dedicated comparison function near `compareNumberedItems`:

```js
// PROVISIONAL -- not yet measured against real photos, see design doc §5.
// The real case this exists for (a 4-line title collapsed to 2 words)
// measures at ~0.22; this sits with wide margin above it and below where
// ordinary OCR noise on a genuine title is expected to land. Task 3 of
// the implementation plan replaces this with a real measured value.
const SIGNATORY_TITLE_SIMILARITY_FLOOR = 0.7;

// signatoryTitle is identified by being the document's one signature-block
// title, not a repeatable key -- same reasoning as compareNumberedItems,
// see docs/superpowers/specs/2026-09-09-signatory-title-comparison-design.md
// §4. A dedicated pass because there is no positional/numeric identity to
// pair on, and because the whole point is comparing free prose tolerantly
// -- exactly what the generic key-based passes are not built for.
function compareSignatoryTitle(authTokens, ocrTokens) {
  const authTok = authTokens.find((t) => t.cls === 'signatoryTitle');
  const ocrTok = ocrTokens.find((t) => t.cls === 'signatoryTitle');
  if (!authTok) return { findings: [], suppressed: 0 };
  if (!ocrTok) {
    return {
      findings: [{
        severity: 'tolerant', cls: 'signatoryTitle', line: authTok.line,
        expected: authTok.value, found: null, reason: 'missing',
      }],
      suppressed: 1,
    };
  }
  const a = keyFor('signatoryTitle', authTok.value).split(' ');
  const o = keyFor('signatoryTitle', ocrTok.value).split(' ');
  if (similarity(a, o) >= SIGNATORY_TITLE_SIMILARITY_FLOOR) return { findings: [], suppressed: 0 };
  return {
    findings: [{
      severity: 'material', cls: 'signatoryTitle', line: authTok.line,
      expected: authTok.value, found: ocrTok.value, reason: 'text',
    }],
    suppressed: 0,
  };
}
```

Exclude `signatoryTitle` from the generic record→photo pass (it has no class guard by default, unlike the photo→record pass, which already only considers `STRICT`/`listItem` classes and so skips `signatoryTitle` naturally) -- add this line right next to the existing `numberedItem` exclusion in that loop:

```js
  for (const t of authTokens) {
    if (t.cls === 'numberedItem') continue; // handled by compareNumberedItems below
    if (t.cls === 'signatoryTitle') continue; // handled by compareSignatoryTitle below
```

Wire the dedicated pass in, right after `compareNumberedItems`'s own result is merged:

```js
  const numbered = compareNumberedItems(authTokens, ocrTokens);
  findings.push(...numbered.findings);
  suppressed += numbered.suppressed;

  const signatoryTitle = compareSignatoryTitle(authTokens, ocrTokens);
  findings.push(...signatoryTitle.findings);
  suppressed += signatoryTitle.suppressed;
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node --test test/pageCompare.test.js`
Expected: PASS, all new tests, no regressions.

- [x] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions.

- [x] **Step 6: Commit**

```bash
git add src/pageCompare.js test/pageCompare.test.js
git commit -m "$(cat <<'EOF'
feat(ocr): compare signatory title as a dedicated material-on-mismatch pass

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Real-photo calibration (required, not optional -- see design doc §5, §7)

**Files:**
- Create: `test/fixtures/pages-special-order-383/1-altered-e.jpg`, `test/fixtures/pages-special-order-383/1-altered-e-b.jpg` (the two real photos of the title-replacement alteration, from this conversation's uploads)
- Modify: `src/pageCompare.js` (only if calibration finds the extraction boundary or the similarity floor needs adjusting -- expect this, per the design doc's own honest §5)
- Test: `test/pageCompare.test.js` (a real-photo regression test, added after calibration confirms the behavior)

**Interfaces:** none new -- this task verifies Tasks 1-2 against real data and adjusts them if reality disagrees.

- [x] **Step 1: Add the two real altered photos as committed fixtures**

These are the two real captures from this conversation showing the actual title-replacement alteration (signature kept, title collapsed to "Regional Director", date also changed to September 16). Save them as:
- `test/fixtures/pages-special-order-383/1-altered-e.jpg` (upload `54cbd9d6-image.jpg`)
- `test/fixtures/pages-special-order-383/1-altered-e-b.jpg` (upload `1494152e-image.jpg`)

```bash
cp "C:/Users/R1-MIS/.claude/uploads/80466add-1029-4b09-8642-418c7348d8f5/54cbd9d6-image.jpg" "test/fixtures/pages-special-order-383/1-altered-e.jpg"
cp "C:/Users/R1-MIS/.claude/uploads/80466add-1029-4b09-8642-418c7348d8f5/1494152e-image.jpg" "test/fixtures/pages-special-order-383/1-altered-e-b.jpg"
```

- [x] **Step 2: Write a calibration probe**

A throwaway script (not committed -- same pattern as `scripts/_spike_*.mjs` used earlier this session), run from the repo root:

```js
// scripts/_calibrate_signatory_title.mjs
import { readFileSync } from 'node:fs';
import { recognize, shutdownOcr } from '../src/ocr.js';
import { extractPageTextsWithLines } from '../src/pdfTools.js';
import { compare, extractTokens } from '../src/pageCompare.js';

const docs = [
  {
    name: 'R1-2026-020780 (Special Order)',
    authPdf: 'sealed/R1-2026-020780.pdf',
    genuine: [
      'test/fixtures/pages-special-order-383/1-genuine.jpg',
      'test/fixtures/pages-special-order-383/1-altered.jpg', // title unaffected by this alteration
      'test/fixtures/pages-special-order-383/1-altered-b.jpg',
      'test/fixtures/pages-special-order-383/1-altered-c.jpg',
      'test/fixtures/pages-special-order-383/1-altered-d.jpg',
    ],
    titleAltered: [
      'test/fixtures/pages-special-order-383/1-altered-e.jpg',
      'test/fixtures/pages-special-order-383/1-altered-e-b.jpg',
    ],
  },
  {
    name: 'R1-2026-010734 (Environmental Compliance Certificate, page 3)',
    authPdf: 'sealed/R1-2026-010734.pdf',
    authPage: 2, // 0-indexed: page 3
    genuine: ['test/fixtures/pages/3-genuine.jpg', 'test/fixtures/pages/3-genuine-b.jpg'],
    titleAltered: [],
  },
];

for (const doc of docs) {
  const authBytes = readFileSync(doc.authPdf);
  const authText = (await extractPageTextsWithLines(authBytes))[doc.authPage ?? 0];
  console.log(`\n=== ${doc.name} ===`);
  console.log('record signatoryTitle:', JSON.stringify(extractTokens(authText).filter((t) => t.cls === 'signatoryTitle')));

  for (const file of doc.genuine) {
    const read = await recognize(readFileSync(file));
    const r = compare(read.text, authText);
    const findings = r.findings.filter((f) => f.cls === 'signatoryTitle');
    console.log(`[genuine] ${file}: ${JSON.stringify(findings)}`);
  }
  for (const file of doc.titleAltered) {
    const read = await recognize(readFileSync(file));
    const r = compare(read.text, authText);
    const findings = r.findings.filter((f) => f.cls === 'signatoryTitle');
    console.log(`[title-altered] ${file}: ${JSON.stringify(findings)}`);
  }
}
await shutdownOcr();
```

Run: `node scripts/_calibrate_signatory_title.mjs`

- [x] **Step 3: Evaluate against the design spec's §7 criteria and iterate if needed**

Required outcomes (per the design doc, non-negotiable before this task is done):
- Every `genuine` photo, both documents: zero `signatoryTitle` findings (or, if extraction happens to miss on a particular noisy real photo, a `tolerant`/`missing` one -- never `material`).
- Both `titleAltered` photos: exactly one `material` `signatoryTitle` finding, `reason: 'text'`.

If any genuine photo produces a `material` false positive, or either altered photo produces no finding at all, this is exactly the situation the design doc's §5 anticipated -- diagnose using the printed record/OCR text (add temporary `console.log` of `extractTokens` output on the failing side, same technique used throughout this session), then fix. Two likely failure shapes, per the design doc's own reasoning:
- **Extraction boundary breaks on real OCR noise** (a stray artifact lands on what should be a blank line, or a genuine blank line gets OCR'd as non-empty): adjust `extractSignatoryTitleToken`'s stopping condition, or fall back to the record-driven (label-guided) pattern `extractFieldTokens` already uses, per design doc §3's stated fallback.
- **Similarity floor is wrong**: use the actual measured similarity scores printed by the calibration script (add a `similarity(...)` printout alongside each finding if not already visible) to set `SIGNATORY_TITLE_SIMILARITY_FLOOR` to a value with real margin on both sides of the observed genuine-vs-altered gap, the same way `MIN_CONFIDENCE` (`src/verifyPageImage.js`) was set from real data.

Re-run Step 2's probe after each change until all criteria pass. Update the constant's comment to describe what was actually measured (removing "PROVISIONAL") once real numbers back it.

- [x] **Step 4: Add a real-photo regression test**

Once calibration passes, add one test to `test/pageCompare.test.js` that locks in the real altered-photo behavior (adjust file paths/expected values to match whatever Step 3 actually confirmed):

```js
test('real photo: the 2026-09-09 signatory-title alteration is caught (calibration)', async () => {
  const { recognize } = await import('../src/ocr.js');
  const { extractPageTextsWithLines } = await import('../src/pdfTools.js');
  const { readFileSync } = await import('node:fs');
  const authBytes = readFileSync('sealed/R1-2026-020780.pdf');
  const authText = (await extractPageTextsWithLines(authBytes))[0];
  const photoBytes = readFileSync('test/fixtures/pages-special-order-383/1-altered-e.jpg');
  const read = await recognize(photoBytes);
  const r = compare(read.text, authText);
  const f = materials(r).find((x) => x.cls === 'signatoryTitle');
  assert.ok(f, 'expected a material signatoryTitle finding on the real altered photo');
});
```

- [x] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions.

- [x] **Step 6: Clean up the throwaway calibration script**

```bash
rm -f scripts/_calibrate_signatory_title.mjs
```

- [x] **Step 7: Commit**

```bash
git add test/fixtures/pages-special-order-383/1-altered-e.jpg test/fixtures/pages-special-order-383/1-altered-e-b.jpg src/pageCompare.js test/pageCompare.test.js docs/superpowers/specs/2026-09-09-signatory-title-comparison-design.md
git commit -m "$(cat <<'EOF'
fix(ocr): calibrate signatory-title extraction and threshold against real photos

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

Also update the design doc's own `**Status:**` line at the top to describe what calibration actually found (mirroring how the numbered-item design doc documents its own real 3-round bounding-rule trail) before this commit, per Step 3's note.
