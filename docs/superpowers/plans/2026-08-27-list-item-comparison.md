# List-Item Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `listItem` token class so an added entry in a hyphen-bulleted
list (e.g. a name inserted into a `RESOURCE PERSONS/GUESTS:` list) becomes a
material finding, while a missing entry stays tolerant.

**Architecture:** One new extraction function (`extractListItemTokens`) that
runs before every other class and claims a bulleted line's entire span; one
new branch in `keyFor` reusing the existing `name`/`field` fold path; one
existing boolean condition in `compare()`'s photo→record "added" pass widened
to admit the new class. No new architecture beyond that — severity for a
missing entry needs no new code at all, since `listItem` simply isn't added
to `STRICT` and therefore falls through to the tolerant path `name` already
uses.

**Tech Stack:** Plain JS (Node's built-in `node:test` + `node:assert/strict`),
no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-list-item-comparison-design.md`

## Global Constraints

- Only a plain hyphen bullet (`- `) is recognized — no `•`, `*`, or numbered
  lists. (Spec §5.)
- `listItem` is never added to `STRICT`. A missing entry must never become
  material, `near`-found or not. (Spec §4.)
- Zero behavior change on `test/fixtures/pages/` (the original fixture set,
  which has zero bulleted lines) — verified in Task 4, not assumed.
- No change to `GLYPH_FOLD`, `foldLetterNoise`, or any existing class's
  extraction pattern. (Spec §6.)

---

### Task 1: Extract `listItem` tokens, claiming the whole bulleted line first

**Files:**
- Modify: `src/pageCompare.js:483-528` (the `TOKEN_PATTERNS` comment block and
  `extractTokens`)
- Test: `test/pageCompare.test.js`

**Interfaces:**
- Produces: `extractListItemTokens(text, claimed)` — same shape as the
  existing `extractMoneyTokens(text, claimed)` (`src/pageCompare.js:321`):
  takes the full text and the per-line `claimed` spans array `extractTokens`
  already builds, returns an array of `{ cls: 'listItem', value, line }`
  tokens, and pushes its own claimed span into `claimed` in place.
- Consumes: `stripFooter` (already defined in this file, used identically by
  `extractMoneyTokens` and every `TOKEN_PATTERNS` entry).

- [ ] **Step 1: Write the failing tests**

Add to `test/pageCompare.test.js`, after the existing field-comparison tests
(after line 248, the `NE: 5 Republic...` test) and before the `import {
compare }` line:

```js
// A hyphen bullet is the only marker actually observed in real photos of
// this document's resource-persons list -- see design doc
// docs/superpowers/specs/2026-08-27-list-item-comparison-design.md §2, §5.
test('a hyphen-bulleted line is captured as a listItem token', () => {
  const t = extractTokens('- Darwin Karl Pua');
  assert.deepEqual(byClass(t, 'listItem'), ['Darwin Karl Pua']);
});

test('a non-bulleted line is not captured as a listItem token', () => {
  const t = extractTokens('Darwin Karl Pua attended the event.');
  assert.deepEqual(byClass(t, 'listItem'), []);
});

// Real shape, 2026-08-27 (test/fixtures/pages-special-order/2-genuine.jpg):
// the existing 'name' pattern already claims the ALL-CAPS run inside this
// exact line ("DENR R1") before listItem ever saw it. Extracting listItem
// FIRST and claiming the whole line is what stops that -- without it, this
// line would be silently dropped from comparison entirely (NUL-contaminated
// remainder), not merely split. See design doc §2, §3.
test('a bulleted line containing an ALL-CAPS run is captured whole, not split by the name pattern', () => {
  const t = extractTokens('- DENR R1 Regional Executive Director');
  assert.deepEqual(byClass(t, 'listItem'), ['DENR R1 Regional Executive Director']);
  assert.deepEqual(byClass(t, 'name'), []);
});

test('a listItem token does not also become a name, money, date, duration, reference, or citation token', () => {
  const t = extractTokens('- 129 Local Government Unit in Region (2pax each)');
  assert.deepEqual(byClass(t, 'listItem'), ['129 Local Government Unit in Region (2pax each)']);
  assert.deepEqual(byClass(t, 'money'), []);
  assert.deepEqual(byClass(t, 'name'), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the four new tests FAIL (`extractTokens` has no `listItem` class
yet, so `byClass(t, 'listItem')` returns `[]` where a value is expected).
Every other existing test still passes.

- [ ] **Step 3: Implement `extractListItemTokens` and wire it in first**

In `src/pageCompare.js`, add the new function directly above the
`TOKEN_PATTERNS` comment block (before line 483):

```js
// A hyphen-bulleted list entry, e.g. "- Darwin Karl Pua". See
// docs/superpowers/specs/2026-08-27-list-item-comparison-design.md.
//
// Unlike every other class, this runs FIRST (see extractTokens) and claims
// the entire line's span, not just the captured value. A list entry is
// compared as one atomic unit -- there's nothing for a later, more specific
// class to usefully claim inside it -- and leaving it late would let 'name'
// (which already claims ALL-CAPS runs like "DENR R1" inside real bulleted
// lines, confirmed 2026-08-27 against a real photo) partially carve up the
// line first, NUL-contaminating the value this would otherwise capture
// whole and silently dropping that entry from comparison.
//
// Only a plain hyphen bullet is recognized -- the one marker actually
// observed, consistently, across every real photo checked. See design doc
// §5.
const LIST_ITEM_LINE = /^\s*-\s+(.+?)\s*$/;

function extractListItemTokens(text, claimed) {
  const rawLines = String(text ?? '').split('\n');
  const out = [];
  rawLines.forEach((raw, i) => {
    const line = stripFooter(raw);
    // No maskClaimed call: this runs before every other extractor (see
    // extractTokens), so claimed[i] is always empty here -- masking would
    // be a guaranteed no-op. If that ordering ever changes, this comment is
    // the tripwire to come back and add it.
    const m = LIST_ITEM_LINE.exec(line);
    if (!m) return;
    claimed[i].push([0, line.length]);
    out.push({ cls: 'listItem', value: m[1], line: i + 1 });
  });
  return out;
}
```

Then update the `TOKEN_PATTERNS` comment (currently `src/pageCompare.js:483-488`):

```js
// Order matters: the first pattern to claim a span wins, so the more specific
// classes are listed before the looser ones. `name` is last because a run of
// capitals would otherwise swallow "Section 12" style citations. Money is not
// in this list at all -- extractTokens runs extractListItemTokens, then
// extractMoneyTokens, ahead of this loop, so between the two of them a
// bulleted list line or an amount still claims first exactly as money did
// when it was the first entry here.
```

Then update `extractTokens` (currently `src/pageCompare.js:518-528`):

```js
export function extractTokens(text, opts = {}) {
  // stripFooter canonicalizes whitespace, which would destroy line structure —
  // so split first and strip the footer per line, keeping line numbers intact.
  const rawLines = String(text ?? '').split('\n');
  const out = [];
  const claimed = rawLines.map(() => []);

  // Runs before every other class -- see extractListItemTokens's own
  // comment for why a bulleted line must claim its whole span first.
  out.push(...extractListItemTokens(text, claimed));

  // Money next, same position it held inside TOKEN_PATTERNS before it moved
  // out to get its own structural filter -- see extractMoneyTokens above.
  out.push(...extractMoneyTokens(text, claimed));
```

(Only the first line of the money comment changes, from "Money first" to
"Money next" — the rest of that comment block is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all four new tests PASS. Every pre-existing test still passes
(255 before this task; confirm the count only grows).

- [ ] **Step 5: Commit**

```bash
git add src/pageCompare.js test/pageCompare.test.js
git commit -m "feat(ocr): extract hyphen-bulleted list lines as listItem tokens"
```

---

### Task 2: Fold `listItem` values through the existing glyph/letter-noise path

**Files:**
- Modify: `src/pageCompare.js:607` (the `keyFor` fold branch)
- Test: `test/pageCompare.test.js`

**Interfaces:**
- Consumes: `foldLetterNoise` (`src/pageCompare.js:635`, unchanged), the
  same helper `name` and `field` already call from `keyFor`.

- [ ] **Step 1: Write the failing tests**

Add to `test/pageCompare.test.js`, after the `FIELD_AUTH`-based fold tests
(after line 379, before the "Real regression 2026-08-25" comment block that
follows):

```js
const LIST_AUTH = [
  'RESOURCE PERSONS/GUESTS:',
  '- Ms. Fernie D. Sitsit',
  '- Atty. Ivy Joyce De Pedro',
  '- Maria Delia Cristina M. Valdez',
  '- DENR R1 Regional Executive Director',
  'The identified personnel are expected to participate during the event '
    + 'and perform as secretariats and other functions deemed necessary for '
    + 'the completion of the Summit.',
].join('\n');

// Real genuine-page noise, 2026-08-27 (test/fixtures/pages-special-order):
// "R1" reads as "RI" on some real captures. Same fold path field/name
// already use for this exact confusion.
test('a listItem value differing only by a classic letter/digit confusion (1 for I) is not reported at all', () => {
  const r = compare(LIST_AUTH.replace('DENR R1', 'DENR RI'), LIST_AUTH);
  assert.deepEqual(r.findings, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAILS. Without the `listItem` branch in `keyFor`, `"DENR R1..."`
and `"DENR RI..."` key differently (no fold applied), so the record token
finds no exact match and reports a tolerant "text" finding — `r.findings`
is not empty as the test asserts.

- [ ] **Step 3: Add the `listItem` branch to `keyFor`**

In `src/pageCompare.js`, change (currently line 607):

```js
  if (cls === 'name' || cls === 'field') return foldLetterNoise(foldedCase);
```

to:

```js
  if (cls === 'name' || cls === 'field' || cls === 'listItem') return foldLetterNoise(foldedCase);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASSES. All pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/pageCompare.js test/pageCompare.test.js
git commit -m "fix(ocr): fold listItem values through the same glyph/letter-noise path as name and field"
```

---

### Task 3: Added `listItem` entries become material; missing ones stay tolerant

**Files:**
- Modify: `src/pageCompare.js:773-774` (the photo→record "added" pass gate
  in `compare()`)
- Test: `test/pageCompare.test.js`

**Interfaces:**
- Consumes: `STRICT` (`src/pageCompare.js:575`, unchanged — `listItem` is
  deliberately never added to this set; see Global Constraints).

- [ ] **Step 1: Write the failing tests**

Add to `test/pageCompare.test.js`, directly after the `LIST_AUTH` fold test
from Task 2:

```js
// The one alteration this whole design exists to catch: a name appended to
// the list with no record counterpart at all (real case, 2026-08-27,
// test/fixtures/pages-special-order/2-altered.jpg — "Darwin Karl Pua").
test('an added list entry with no record counterpart is reported as material', () => {
  const ocr = LIST_AUTH.replace(
    '- DENR R1 Regional Executive Director',
    '- DENR R1 Regional Executive Director\n- Darwin Karl Pua',
  );
  const r = compare(ocr, LIST_AUTH);
  assert.deepEqual(materials(r), [{
    severity: 'material', cls: 'listItem', line: null,
    expected: null, found: 'Darwin Karl Pua', reason: 'added',
  }]);
});

// Real genuine photos (2026-08-27) demonstrated ordinary OCR can drop most
// of a bulleted list under normal capture conditions -- treating an absence
// as material would flag a normal bad-angle photo as tampered. See design
// doc §2, §4.
test('a list entry missing from the photo is tolerant, never material', () => {
  const ocr = LIST_AUTH.replace('- Atty. Ivy Joyce De Pedro\n', '');
  const r = compare(ocr, LIST_AUTH);
  assert.deepEqual(materials(r), []);
  const tolerant = r.findings.filter((f) => f.severity === 'tolerant' && f.cls === 'listItem');
  assert.equal(tolerant.length, 1);
  assert.equal(tolerant[0].expected, 'Atty. Ivy Joyce De Pedro');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the "added" test FAILS (`listItem` isn't in `STRICT`, so the
photo→record pass never even looks at it — `materials(r)` is `[]`, not the
expected single finding). The "missing" test PASSES already (this is the
existing tolerant behavior every non-`STRICT` class already gets, verified
here for the record).

- [ ] **Step 3: Widen the added-pass gate**

In `src/pageCompare.js`, change (currently line 774):

```js
    if (!STRICT.has(o.cls)) continue;
```

to:

```js
    if (!STRICT.has(o.cls) && o.cls !== 'listItem') continue;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: both tests PASS. Full suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/pageCompare.js test/pageCompare.test.js
git commit -m "feat(ocr): an added list entry with no record counterpart is a material finding"
```

---

### Task 4: Real-photo calibration verification

No code changes. This task exists because every prior feature in this
project was verified against real photos before being called done, and this
design's whole motivation (§2 of the spec) came from real calibration data —
skipping this step would mean shipping on the strength of unit tests alone,
which this codebase's own history shows is not sufficient (the first
labeled-field attempt passed its unit tests and still failed real-photo
verification twice).

- [ ] **Step 1: Run calibration against the special-order fixture set**

```bash
node scripts/ocr-calibrate.mjs sealed/R1-2026-001024.pdf test/fixtures/pages-special-order
```

Expected, per design doc §7:
- `2-altered.jpg` now shows at least 1 material finding (`cls: listItem`,
  `reason: added`, `found` containing "Darwin Karl Pua") — check the
  "criterion 4: known alterations are caught" section of the output.
- Every genuine photo (`1-genuine.jpg`, `2-genuine.jpg`, `2-genuine-b.jpg`)
  still shows **zero** material findings — check "criterion 1" still reads
  `0 with material findings`, even though at least one of these photos is
  known to under-recognize most of the list.

If a genuine photo shows a material `listItem` finding, STOP — do not
proceed or paper over it. Return to Phase 1 of systematic-debugging: this
means either the added-pass is somehow firing on a token that should have
matched by key (a fold gap Task 2 didn't cover), or a genuine photo is
producing a `listItem` value with no plausible record counterpart at all
(extraction picking up noise as a bulleted line). Diagnose against the
actual OCR text before changing anything.

- [ ] **Step 2: Run calibration against the original fixture set**

```bash
node scripts/ocr-calibrate.mjs scripts/print-test-sealed.pdf test/fixtures/pages
```

Expected: **identical output to the pre-Task-1 baseline** — this document
has zero bulleted lines, so `listItem` extraction must be a no-op here. The
only known-accepted material finding should still be the single
already-documented dropped-trailing-letter exception on `1-genuine.jpg`
(design doc `2026-08-25-labeled-field-comparison-design.md` §6 —
`Northern Luzon Aggregates Corporation` → `Norther Luzon Aggregates
Corporation`). Any *new* material finding here is a regression — STOP and
diagnose before proceeding.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass (255 baseline + the 8 new tests from Tasks 1-3 =
263).

- [ ] **Step 4: Update the spec's status line**

In `docs/superpowers/specs/2026-08-27-list-item-comparison-design.md`,
change the `**Status:**` line from `Approved design, pre-implementation` to
a short summary of what real-photo verification confirmed (following this
project's established convention — see the `**Status:**` line of
`2026-08-25-labeled-field-comparison-design.md` for the style: name what
held, name any accepted exception).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-27-list-item-comparison-design.md
git commit -m "docs(ocr): confirm list-item comparison against real-photo calibration"
```
