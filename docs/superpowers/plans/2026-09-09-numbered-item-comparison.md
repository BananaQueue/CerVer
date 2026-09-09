# Numbered-Item Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `numberedItem` token class so a genuine name substitution at
a stable number in a numbered list (e.g. `9. Darwin Karl B. Pua` becoming
`9. Someone Else`) becomes a material finding, while a missing entry stays
tolerant and a completely different real document's wrapped multi-line
numbered list is never touched at all.

**Architecture:** One new extraction function (`extractNumberedItemTokens`)
that splits a line on every digit-period marker found (not just the first
— this document's list prints in two side-by-side columns) and only trusts
a segment when a bounding rule confirms it isn't a wrapped continuation.
One new `keyFor` branch reusing the existing `name`/`field`/`listItem` fold
path. One new, dedicated comparison pass (`compareNumberedItems`) — unlike
every other class, identity here is the item's *number*, not a fold of its
value, so it can't be shoehorned into `compare()`'s generic key-based
passes; those are instead told to skip `numberedItem` tokens entirely.

**Tech Stack:** Plain JS (Node's built-in `node:test` + `node:assert/strict`),
no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-numbered-item-comparison-design.md`

## Global Constraints

- Only a plain `N.` marker is recognized, 1-2 digits (`\d{1,2}`). No `N)`,
  no Roman numerals, no lettered sub-items. (Spec §5.)
- A segment is extracted only when bounded: another marker later on the
  same line, the next physical line itself starting with a marker, or
  being the text's last line. Anything else is presumed a wrapped
  continuation and is not extracted, on either side. (Spec §2, §3.)
- `numberedItem` participates in its own dedicated `compareNumberedItems`
  pass only — it must be excluded from both of `compare()`'s generic
  record↔photo passes, which key on folded value, not number. (Spec §4.)
- No change to `GLYPH_FOLD`, `foldLetterNoise`, `isWrapPrefix`, or any
  existing class's extraction pattern. (Spec §6.)
- Zero behavior change on `test/fixtures/pages/` (the legal-clause
  document) — verified in Task 3, not assumed.

---

### Task 1: Extract `numberedItem` tokens, splitting each line on every marker

**Files:**
- Modify: `src/pageCompare.js:656-702` (`extractTokens`, and the area just
  above it where `extractListItemTokens` and `LIST_ITEM_LINE` live)
- Test: `test/pageCompare.test.js`

**Interfaces:**
- Produces: `extractNumberedItemTokens(text, claimed)` — same
  `(text, claimed) -> tokens[]` shape as `extractListItemTokens`
  (`src/pageCompare.js:590`), but each token is
  `{ cls: 'numberedItem', number, value, line }` (an extra `number` field
  no other class's tokens carry).

- [ ] **Step 1: Write the failing tests**

Add to `test/pageCompare.test.js`, directly after the last `listItem`
extraction test (the "does not also become a name, money, date, duration,
reference, or citation token" test, currently ending around line 331) and
before the `import { compare }` line:

```js
// A numbered list entry, e.g. "9. Darwin Karl B. Pua". Unlike a hyphen
// bullet, several items can share one physical OCR line -- this real
// document's list prints in two side-by-side columns. See design doc
// docs/superpowers/specs/2026-09-09-numbered-item-comparison-design.md §2, §3.
test('a numbered list line is captured as a numberedItem token', () => {
  const t = extractTokens('9. Darwin Karl B. Pua\n10. John Ruskhin P. Salayon');
  const items = t.filter((x) => x.cls === 'numberedItem').map((x) => [x.number, x.value]);
  assert.deepEqual(items, [['9', 'Darwin Karl B. Pua'], ['10', 'John Ruskhin P. Salayon']]);
});

// Real shape, 2026-09-09 (sealed/R1-2026-020780.pdf, two-column layout):
// "Chester Lyndon S. Padilla 11. Mardave G. Nerveza" is items 1 and 11 on
// one physical line. A naive "first marker per line" extraction would
// swallow the second item's content into the first item's value.
test('a line containing two numbered items (a two-column layout) splits into both', () => {
  const t = extractTokens(
    '1. Chester Lyndon S. Padilla 11. Mardave G. Nerveza\n'
    + '2. Roderick F. Valdez 12. Melody V. Sabado',
  );
  const items = t.filter((x) => x.cls === 'numberedItem').map((x) => [x.number, x.value]);
  assert.deepEqual(items, [
    ['1', 'Chester Lyndon S. Padilla'], ['11', 'Mardave G. Nerveza'],
    ['2', 'Roderick F. Valdez'], ['12', 'Melody V. Sabado'],
  ]);
});

// Real regression risk, 2026-09-09: a completely different real document
// (test/fixtures/pages/, legal clauses) has its own numbered list, but
// each item wraps across two or three physical lines. Without the
// bounding rule this line would be truncated to its first physical line
// and compared against a genuine photo's own, differently-positioned
// truncation -- a live false-positive risk on an already-shipped feature.
test('a numbered item whose content runs to end of line with no bounding marker is not extracted (a wrapped continuation)', () => {
  const t = extractTokens(
    '3. Effluent shall conform to DENR Administrative Order 2016-08, Class C\n'
    + 'inland water standards. Quarterly sampling shall be undertaken by a\n'
    + 'DENR-recognized laboratory.',
  );
  assert.deepEqual(t.filter((x) => x.cls === 'numberedItem'), []);
});

test('a numbered item on the very last line of the text is extracted, even with nothing after it to bound it', () => {
  const t = extractTokens('17. Edison A. Rabo\n18. Van Kenji R. Maglaque');
  const items = t.filter((x) => x.cls === 'numberedItem').map((x) => [x.number, x.value]);
  assert.deepEqual(items, [['17', 'Edison A. Rabo'], ['18', 'Van Kenji R. Maglaque']]);
});

// The accepted honest limit (design doc §5): this shape is indistinguishable,
// locally, from the wrapped-clause case above, so it is not extracted --
// not a photo-reading problem, a property of the text itself.
test('a numbered item followed by ordinary prose, not another marker, and not the last line, is not extracted', () => {
  const t = extractTokens('18. Van Kenji R. Maglaque\nServices rendered by permanent personnel shall be credited.');
  assert.deepEqual(t.filter((x) => x.cls === 'numberedItem'), []);
});

// Mirrors listItem's own protection (design doc §3): claiming the whole
// segment first stops 'name' from partially claiming an ALL-CAPS run
// inside it, which would otherwise NUL-contaminate the remainder.
test('a numbered item containing an ALL-CAPS run is captured whole, not split by the name pattern', () => {
  const t = extractTokens('9. DENR REGIONAL DIRECTOR\n10. Someone Else');
  assert.deepEqual(byClass(t, 'name'), []);
  const items = t.filter((x) => x.cls === 'numberedItem').map((x) => [x.number, x.value]);
  assert.deepEqual(items, [['9', 'DENR REGIONAL DIRECTOR'], ['10', 'Someone Else']]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the first, second, fourth, and sixth tests FAIL (no `numberedItem`
class exists yet, so the filtered arrays come back empty where values are
expected). The third and fifth tests ("not extracted") already PASS
trivially — there is no `numberedItem` class yet, so nothing is ever
extracted; that's expected and fine, they lock in intended behavior for
Task 2 onward. Every pre-existing test still passes.

- [ ] **Step 3: Implement `extractNumberedItemTokens` and wire it in**

In `src/pageCompare.js`, add the new function and its pattern directly
above the `LIST_ITEM_LINE`/`extractListItemTokens` block (before the
current line 588):

```js
// A numbered list entry, e.g. "9. Darwin Karl B. Pua". Unlike a hyphen
// bullet (see extractListItemTokens below), several items can share one
// physical OCR line: this document's list prints in two side-by-side
// columns ("Chester Lyndon S. Padilla 11. Mardave G. Nerveza" is items 1
// and 11 on one line), so this splits a line on EVERY marker found, not
// just the first. See
// docs/superpowers/specs/2026-09-09-numbered-item-comparison-design.md.
//
// A segment is only trusted -- extracted at all -- when unambiguously
// bounded: by another marker later on the same line, by the next physical
// line itself starting with a marker, or by being the text's last line.
// Real case, 2026-09-09: a completely different real document
// (test/fixtures/pages/, legal clauses) has its own numbered list, but
// each item wraps across two or three physical lines ("3. Effluent shall
// conform to... / inland water standards..."). Without this bounding
// rule, that document's clauses would be silently truncated to their
// first physical line and compared against a genuine photo's own
// (differently-positioned) truncation -- a live false-positive risk on an
// already-shipped feature, not a hypothetical. Checked directly against
// that document and all 3 of its real genuine photos: zero items
// extracted, either side, with this rule in place.
//
// The cost, found the same way: a segment that legitimately ends a
// document's own list, with ordinary prose (not another marker)
// immediately following and not literally the page's last line, is ALSO
// not trusted -- there is no local way to tell that apart from a wrapped
// continuation. Accepted, documented gap, not an oversight -- see the
// design doc's honest limits (§5).
const NUMBERED_MARKER = /\b(\d{1,2})\.\s+/g;

function extractNumberedItemTokens(text, claimed) {
  const rawLines = String(text ?? '').split('\n');
  const stripped = rawLines.map((raw) => stripFooter(raw));
  const lineMarkers = stripped.map((line) => [...line.matchAll(NUMBERED_MARKER)]);
  const out = [];
  lineMarkers.forEach((markers, i) => {
    if (markers.length === 0) return;
    const nextLineStartsWithMarker = i + 1 < stripped.length
      && /^\s*\d{1,2}\.\s+/.test(stripped[i + 1]);
    const isLastLine = i === stripped.length - 1;
    // No maskClaimed call: this runs before every other extractor (see
    // extractTokens), so claimed[i] is always empty here -- masking would
    // be a guaranteed no-op. If that ordering ever changes, this comment
    // is the tripwire to come back and add it.
    markers.forEach((m, idx) => {
      const hasNextOnLine = idx + 1 < markers.length;
      const end = hasNextOnLine ? markers[idx + 1].index : stripped[i].length;
      if (!hasNextOnLine && !nextLineStartsWithMarker && !isLastLine) return;
      const start = m.index + m[0].length;
      const value = stripped[i].slice(start, end).trim();
      if (!value) return;
      claimed[i].push([m.index, end]);
      out.push({ cls: 'numberedItem', number: m[1], value, line: i + 1 });
    });
  });
  return out;
}
```

Then in `extractTokens` (currently `src/pageCompare.js:656-669`), add the
new call right after `extractListItemTokens`'s:

```js
  // Runs before every other class -- see extractListItemTokens's own
  // comment for why a bulleted line must claim its whole span first.
  out.push(...extractListItemTokens(text, claimed));

  // Same reasoning, same position -- see extractNumberedItemTokens's own
  // comment for the bounding rule this needs that extractListItemTokens
  // does not.
  out.push(...extractNumberedItemTokens(text, claimed));

  // Money next, same position it held inside TOKEN_PATTERNS before it moved
  // out to get its own structural filter -- see extractMoneyTokens above.
  out.push(...extractMoneyTokens(text, claimed));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all six new tests PASS. Every pre-existing test still passes.

- [ ] **Step 5: Commit**

```bash
git add src/pageCompare.js test/pageCompare.test.js
git commit -m "feat(ocr): extract numbered list lines as numberedItem tokens"
```

---

### Task 2: Fold `numberedItem` values, and compare them via a dedicated pass

Combined into one task rather than split by file/interface: the fold
branch has no independently observable effect until the dedicated
comparison pass exists to produce a `numberedItem` finding at all, and the
pass's mismatch detection depends on the fold to correctly forgive OCR
noise. Splitting them would leave Task 2's test unverifiable in isolation.

**Files:**
- Modify: `src/pageCompare.js:749` (the `keyFor` fold branch); add
  `compareNumberedItems` near `isWrapPrefix` (currently ending around line
  810); modify `compare()` (currently `src/pageCompare.js:820-957`)
- Test: `test/pageCompare.test.js`

**Interfaces:**
- Consumes: `foldLetterNoise` (`src/pageCompare.js:777`, unchanged), the
  same helper `name`, `field`, and `listItem` already call from `keyFor`;
  `isWrapPrefix` (`src/pageCompare.js:805`, unchanged).
- Produces: `compareNumberedItems(authTokens, ocrTokens)` →
  `{ findings, suppressed }`, called once from `compare()`.

- [ ] **Step 1: Write the failing tests**

Add to `test/pageCompare.test.js`, after the `import { compare }` line and
its surrounding `AUTH`/`materials` setup (find the existing `LIST_AUTH`
block, currently defined for the `listItem` tests, and add everything
below directly after `listItem`'s own fold test, "a listItem value
differing only by a classic letter-run confusion (rn for m) is not
reported at all"):

```js
// Real shape, sealed/R1-2026-020780.pdf: a two-column numbered personnel
// list. Deliberately 4 items, not the document's real 18 -- #8/#9/#10 are
// each bounded by the marker that follows them; #11 is left unbounded on
// purpose (followed by ordinary prose, not the text's last line), mirroring
// the real document's own last-item gap (design doc §5) so no test here
// accidentally depends on an item this design cannot see.
const NUMBERED_AUTH = [
  'RESOURCE PERSONS:',
  '8. John Nichol D. Parong',
  '9. Maria Fernando Cruz',
  '10. Darwin Karl B. Pua',
  '11. John Ruskhin P. Salayon',
  'The identified personnel are expected to participate during the event '
    + 'and perform necessary support functions for the Summit.',
].join('\n');

test('a numberedItem value differing only by a classic letter-run confusion (rn for m) is not reported at all', () => {
  const r = compare(NUMBERED_AUTH.replace('Fernando', 'Femando'), NUMBERED_AUTH);
  assert.deepEqual(materials(r).filter((f) => f.cls === 'numberedItem'), []);
});

// The case this whole design exists for: a genuine substitution at a
// stable number. Real cases, 2026-09-09 (sealed/R1-2026-020780.pdf):
// "Lawrence" -> "Laurence", "Nichol" -> "Nicole" -- different people, not
// OCR noise.
test('a numberedItem value that genuinely differs at the same number is material', () => {
  const ocr = NUMBERED_AUTH.replace('Darwin Karl B. Pua', 'Someone Else Entirely');
  const r = compare(ocr, NUMBERED_AUTH);
  const f = materials(r).find((x) => x.cls === 'numberedItem');
  assert.ok(f, 'expected a material numberedItem finding');
  assert.equal(f.expected, 'Darwin Karl B. Pua');
  assert.equal(f.found, 'Someone Else Entirely');
  assert.equal(f.reason, 'text');
});

// Trailing OCR noise, the same shape isWrapPrefix already forgives for
// name/field/listItem, forgiven here too via the same helper.
test('a numberedItem value with trailing OCR noise, where the record value is a clean prefix, is not reported', () => {
  const ocr = NUMBERED_AUTH.replace('10. Darwin Karl B. Pua', '10. Darwin Karl B. Pua 4');
  const r = compare(ocr, NUMBERED_AUTH);
  assert.deepEqual(materials(r).filter((f) => f.cls === 'numberedItem'), []);
});

// Real genuine photos demonstrated ordinary OCR can drop list content
// under normal capture conditions (see the listItem design doc) --
// treating an absence as material would flag a normal bad-angle photo as
// tampered. The same reasoning applies here.
test('a numbered item missing from the photo is tolerant, never material', () => {
  const ocr = NUMBERED_AUTH.replace('10. Darwin Karl B. Pua\n', '');
  const r = compare(ocr, NUMBERED_AUTH);
  assert.deepEqual(materials(r).filter((f) => f.cls === 'numberedItem'), []);
  const tolerant = r.findings.filter((f) => f.severity === 'tolerant' && f.cls === 'numberedItem');
  assert.equal(tolerant.length, 1);
  assert.equal(tolerant[0].expected, 'Darwin Karl B. Pua');
});

// Mirrors listItem's and every STRICT class's existing added-pass.
test('an added numbered item with no record counterpart is reported as material', () => {
  const ocr = `${NUMBERED_AUTH}\n11. Extra Person Name`;
  const r = compare(ocr, NUMBERED_AUTH);
  const found = materials(r).filter((f) => f.cls === 'numberedItem');
  assert.deepEqual(found, [{
    severity: 'material', cls: 'numberedItem', line: null,
    expected: null, found: 'Extra Person Name', reason: 'added',
  }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: all five new tests FAIL. `numberedItem` tokens currently fall
through `compare()`'s generic tolerant path (the class isn't in `STRICT`,
and isn't yet excluded from the generic passes), so none of these produce
the right finding shape — the missing-entry test may pass incidentally,
but re-check it once Step 3 lands, since it needs to pass for the right
reason (the dedicated pass), not the generic one.

- [ ] **Step 3: Add the `keyFor` branch, `compareNumberedItems`, exclude the class from the generic passes, wire it in**

In `src/pageCompare.js`, change (currently line 749):

```js
  if (cls === 'name' || cls === 'field' || cls === 'listItem') return foldLetterNoise(foldedCase);
```

to:

```js
  if (cls === 'name' || cls === 'field' || cls === 'listItem' || cls === 'numberedItem') return foldLetterNoise(foldedCase);
```

In `src/pageCompare.js`, add this function directly after `isWrapPrefix`
(currently ending at line 810, right before `function indexByKey`):

```js
// numberedItem is identified by its NUMBER, not a fold of its value --
// every other class's identity IS its folded value, which is what
// compare()'s generic record<->photo passes key on. Forcing numberedItem
// through that mechanism would mean "same key" stops meaning "same
// content" for this one class, so it gets its own dedicated pass instead;
// compare() excludes numberedItem tokens from both generic passes (search
// for "cls === 'numberedItem'" there). See
// docs/superpowers/specs/2026-09-09-numbered-item-comparison-design.md §4.
function compareNumberedItems(authTokens, ocrTokens) {
  const authByNum = new Map();
  for (const t of authTokens) if (t.cls === 'numberedItem') authByNum.set(t.number, t);
  const ocrByNum = new Map();
  for (const t of ocrTokens) if (t.cls === 'numberedItem') ocrByNum.set(t.number, t);

  const findings = [];
  let suppressed = 0;

  for (const [num, authTok] of authByNum) {
    const ocrTok = ocrByNum.get(num);
    if (!ocrTok) {
      suppressed++;
      findings.push({
        severity: 'tolerant', cls: 'numberedItem', line: authTok.line,
        expected: authTok.value, found: null, reason: 'missing',
      });
      continue;
    }
    const a = keyFor('numberedItem', authTok.value);
    const o = keyFor('numberedItem', ocrTok.value);
    if (a === o || isWrapPrefix(a, o)) continue;
    findings.push({
      severity: 'material', cls: 'numberedItem', line: authTok.line,
      expected: authTok.value, found: ocrTok.value, reason: 'text',
    });
  }

  for (const [num, ocrTok] of ocrByNum) {
    if (authByNum.has(num)) continue;
    findings.push({
      severity: 'material', cls: 'numberedItem', line: null,
      expected: null, found: ocrTok.value, reason: 'added',
    });
  }

  return { findings, suppressed };
}
```

Then in `compare()`, exclude `numberedItem` from both generic passes.
First, the record→photo pass (currently starting at line 858):

```js
  // Record -> photo. Did every value survive?
  for (const t of authTokens) {
    if (t.cls === 'numberedItem') continue; // handled by compareNumberedItems below
    const key = keyFor(t.cls, t.value);
```

Then the photo→record pass (currently starting at line 933):

```js
  for (const o of ocrTokens) {
    if (o.cls === 'numberedItem') continue; // handled by compareNumberedItems below
    if (!STRICT.has(o.cls) && o.cls !== 'listItem') continue;
```

Finally, call `compareNumberedItems` and merge its results in, right after
the photo→record loop closes (currently line 946, before the "Word-level
differences" comment):

```js
  const numbered = compareNumberedItems(authTokens, ocrTokens);
  findings.push(...numbered.findings);
  suppressed += numbered.suppressed;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all five new tests PASS. Full suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/pageCompare.js test/pageCompare.test.js
git commit -m "feat(ocr): fold numberedItem values and compare them via a dedicated pass"
```

---

### Task 3: Real-photo calibration verification

No code changes. Every prior feature in this project was verified against
real photos before being called done, and this design's whole motivation
(spec §2) came from checking real photos of two structurally different
documents — skipping this step would mean shipping on unit tests alone,
which this codebase's own history (the first `listItem` attempt, twice)
shows is not sufficient.

- [ ] **Step 1: Run calibration against the special-order-383 fixture set**

```bash
node scripts/ocr-calibrate.mjs sealed/R1-2026-020780.pdf test/fixtures/pages-special-order-383
```

Expected, per design doc §7:
- `1-genuine.jpg` shows **zero** material `numberedItem` findings.
- `1-altered-b.jpg` and `1-altered-d.jpg` each report their real name
  substitution as material (`"Lawrence" -> "Laurence"` and `"Nichol" ->
  "Nicole"` respectively) — check "criterion 4: known alterations are
  caught."
- `1-altered.jpg` and `1-altered-c.jpg` still show `CAUGHT NOTHING` for the
  numbered-list alteration specifically — this is the accepted §5 limit,
  confirmed as expected, not a bug. (`1-altered.jpg`'s money-reference
  finding and `1-altered-d.jpg`'s money finding, from earlier fixes, are
  unrelated and should be unaffected.)

If a genuine photo shows a material `numberedItem` finding, STOP — do not
proceed or paper over it. Return to Phase 1 of systematic-debugging: check
the actual OCR text and the actual bounding decision made for that line
before changing anything.

- [ ] **Step 2: Run calibration against the original fixture set (the legal-clause document)**

```bash
node scripts/ocr-calibrate.mjs scripts/print-test-sealed.pdf test/fixtures/pages
```

Expected: **identical output to the pre-Task-1 baseline** — this document's
numbered list is entirely made of wrapped multi-line clauses, so the
bounding rule must extract zero `numberedItem` tokens here, on the record
or any of its 6 real genuine photos. Any *new* finding of any kind here is
a regression — STOP and diagnose before proceeding.

- [ ] **Step 3: Run calibration against the special-order fixture set (unrelated document, no numbered list)**

```bash
node scripts/ocr-calibrate.mjs sealed/R1-2026-001024.pdf test/fixtures/pages-special-order
```

Expected: **identical output to the pre-Task-1 baseline** — this document
has a hyphen-bulleted list, not a numbered one; confirms `numberedItem`
extraction is a true no-op here too.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass (283 baseline + 6 from Task 1 + 5 from Task 2 = 294).

- [ ] **Step 5: Update the spec's status line**

In `docs/superpowers/specs/2026-09-09-numbered-item-comparison-design.md`,
change the `**Status:**` line from `Approved design, pre-implementation` to
a short summary of what real-photo verification confirmed, following this
project's established convention (see `2026-08-27-list-item-comparison-design.md`'s
`**Status:**` line for the style: name what held, name the accepted
exceptions).

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-09-09-numbered-item-comparison-design.md
git commit -m "docs(ocr): confirm numbered-item comparison against real-photo calibration"
```
