# Labeled Field Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect and compare `Label : Value` lines (`Proponent : Northern Luzon Aggregates Corporation`) as a new strict token class, catching alterations in ordinary sentence-case fields that no existing token class covers, while forgiving the same classes of OCR noise already proven safe elsewhere in this codebase.

**Architecture:** A new extraction function, `extractFieldTokens`, alongside the existing `extractMoneyTokens` — not a `TOKEN_PATTERNS` entry, since each match's identity comes from what it captures. Tolerance reuses `foldGlyphs` and a newly-extracted `foldLetterNoise` (pulled out of the current `foldNameNoise`, which also fixes a real fold-order bug found while designing this). `field` joins `STRICT`; `compare()`'s existing pairing/missing/added/reason logic needs no changes at all.

**Tech Stack:** Node.js, `node:test`. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-08-25-labeled-field-comparison-design.md](../specs/2026-08-25-labeled-field-comparison-design.md)

## Global Constraints

- `stripFooter()`/`FOOTER_RE` (`src/sealCode.js`) must not be modified.
- No existing `STRICT` class's extraction pattern changes.
- `compare()`'s pairing, missing/added, and `reasonFor` logic must not be modified — `field` only ever needs to join `STRICT`, nothing else in `compare()` changes.
- Tests are run from the repo root: `node --test 'test/*.test.js'`.

---

### Task 1: Fix `keyFor`'s fold-order bug; extract `foldLetterNoise`

**Files:**
- Modify: `src/pageCompare.js`
- Modify: `test/pageCompare.test.js`

**Interfaces:**
- Produces: `foldLetterNoise(s: string) => string` (module-private, not exported) — folds `rn→m`, `cl→d`, `vv→w` on an already-lowercased string. Task 2 reuses this for the `field` key.
- Consumes: nothing new.

**Background:** `keyFor`'s `name` branch currently does `foldNameNoise(collapsed.toLowerCase())` — lowercasing *before* folding. The comment two lines below it (for the `money` path) explains exactly why that order is wrong: `GLYPH_FOLD`'s `B`, `D`, `Q`, `S`, `Z`, `G` entries are uppercase-only, so folding an already-lowercased string leaves those six of eight rules dead. This has been silently true for every `name` comparison since it was written. It matters now because `field` (Task 2) depends on this exact fold working — the real calibration data behind this whole feature (`Category B` photographed as `Category 8`) is precisely a case the six "dead" rules exist to forgive.

- [ ] **Step 1: Write the failing test**

In `test/pageCompare.test.js`, find the existing test `'a name with two character errors is tolerant, not material'` (it uses `l`/`I` confusions, which survive regardless of fold order, so it doesn't already cover this). Add a new test directly after it:

```js
// keyFor's name branch used to lowercase before folding, so GLYPH_FOLD's six
// uppercase-only entries (B, D, Q, S, Z, G) never fired for a name -- found
// 2026-08-25 while adding the 'field' class, which depends on this exact
// fold. B is the clearest of the six to demonstrate with a real word.
test('a name with an uppercase-only glyph confusion (B for 8) is not reported as a difference at all', () => {
  const auth = AUTH.replace('ACME MINING CORPORATION', 'ACME MINING BUREAU');
  const r = compare(auth.replace('ACME MINING BUREAU', 'ACME MINING 8UREAU'), auth);
  assert.deepEqual(r.findings, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/pageCompare.test.js`
Expected: FAIL — the old fold order leaves `B`/`8` unforgiven, so this produces one tolerant finding instead of none.

- [ ] **Step 3: Fix the fold order and extract `foldLetterNoise`**

In `src/pageCompare.js`, find:

```js
function keyFor(cls, value) {
  const collapsed = String(value).replace(/\s+/g, ' ').trim();
  if (cls === 'name') return foldNameNoise(collapsed.toLowerCase());
  // Fold before lowercasing, not after: GLYPH_FOLD's B, D, Q, S, Z, G entries
  // are uppercase-only (no lowercase counterpart), so folding a
  // pre-lowercased string leaves six of the map's eight letter rules dead.
  // Folding the original-case value first keeps every entry live.
  const key = foldGlyphs(collapsed).toLowerCase().replace(/^(?:php|p)\s?/, '₱');
  // Money only. reasonFor's digit-count comparison is unaffected: digitsOf
  // drops every non-digit anyway, so materiality is decided on real digits
  // (50,000 -> 5 vs 500,000 -> 6) regardless of what the key does.
  if (cls !== 'money') return key;
```

Replace it with:

```js
function keyFor(cls, value) {
  const collapsed = String(value).replace(/\s+/g, ' ').trim();
  // Fold before lowercasing, not after, for every class: GLYPH_FOLD's B, D,
  // Q, S, Z, G entries are uppercase-only (no lowercase counterpart), so
  // folding an already-lowercased string leaves six of the map's eight
  // letter rules dead. 'name' used to lowercase first, silently losing
  // those six rules for every name comparison -- found 2026-08-25 while
  // adding 'field' below, whose own real calibration data (a genuine
  // "Category B" photographed as "Category 8") depends on this fold
  // actually running. Fixed for both classes at once, here.
  const foldedCase = foldGlyphs(collapsed).toLowerCase();
  if (cls === 'name' || cls === 'field') return foldLetterNoise(foldedCase);
  const key = foldedCase.replace(/^(?:php|p)\s?/, '₱');
  // Money only. reasonFor's digit-count comparison is unaffected: digitsOf
  // drops every non-digit anyway, so materiality is decided on real digits
  // (50,000 -> 5 vs 500,000 -> 6) regardless of what the key does.
  if (cls !== 'money') return key;
```

Then find:

```js
// Tolerant classes: fold the confusions that dominate OCR of long words, so a
// name is only reported when it differs by more than the camera plausibly does.
function foldNameNoise(s) {
  return foldGlyphs(s).replace(/rn/g, 'm').replace(/cl/g, 'd').replace(/vv/g, 'w');
}
```

Replace it with:

```js
// Multi-letter OCR confusions that dominate long words -- shared by tolerant
// name comparison and strict field-value comparison (see keyFor above).
// Kept separate from foldGlyphs, a single-character map reused by
// money/reference/citation too that must run before lowercasing; these
// letter-RUN folds only make sense on an already-lowercased string, which
// keyFor guarantees before calling this.
function foldLetterNoise(s) {
  return s.replace(/rn/g, 'm').replace(/cl/g, 'd').replace(/vv/g, 'w');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/pageCompare.test.js`
Expected: all tests pass, including the new one.

- [ ] **Step 5: Run the whole suite**

Run: `node --test 'test/*.test.js'`
Expected: every test passes — this fix only ever makes `name` comparisons *more* forgiving (tolerant class, never material either way), so nothing that passed before can now fail.

- [ ] **Step 6: Commit**

```bash
git add src/pageCompare.js test/pageCompare.test.js
git commit -m "$(cat <<'EOF'
fix(ocr): fold before lowercasing for name comparisons too

keyFor's name branch lowercased before folding, unlike the money path
right below it (whose own comment explains why that order is wrong):
GLYPH_FOLD's B, D, Q, S, Z, G entries are uppercase-only, so folding an
already-lowercased string leaves six of the map's eight letter rules
dead. Found while designing the labeled-field comparison feature,
which depends on this exact fold (a real "Category B" was photographed
as "Category 8"). Extracted the shared letter-run folds into
foldLetterNoise so the upcoming field class can reuse them too.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `extractFieldTokens` — detect and compare labeled fields

**Files:**
- Modify: `src/pageCompare.js`
- Modify: `test/pageCompare.test.js`

**Interfaces:**
- Consumes: `foldLetterNoise` (Task 1), `foldGlyphs`, `maskClaimed`, `NUL`, `stripFooter` — all already in this file.
- Produces: a new token class `'field'`, extracted into the same `out` array `extractTokens()` already returns; joins `STRICT`. No new exported functions.

- [ ] **Step 1: Write the failing tests**

In `test/pageCompare.test.js`, add near the other `extractTokens` tests (after `'no strict-class token is lost to an adjacent match'`):

```js
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
```

Then add near the other `compare()` tests, after the existing letter-for-digit suppression tests. First, a shared fixture (add this once, above the new tests):

```js
const FIELD_AUTH = [
  'ENVIRONMENTAL COMPLIANCE CERTIFICATE',
  'Proponent : Northern Luzon Aggregates Corporation',
  'Location : Barangay Poblacion, San Fernando City, La Union',
  'Classification : Category B — Environmentally Critical Area',
  'The Proponent shall implement the Environmental Management Plan submitted',
  'as part of the Initial Environmental Examination, and shall comply.',
].join('\n');
```

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/pageCompare.test.js`
Expected: FAIL — `field` is not yet extracted at all, so `byClass(t, 'field')` is always `[]` and every `compare()`-based test above sees no `field` finding (the "not reported at all" tests would currently pass vacuously with no findings either way, but the two "is material" tests will fail since no `field` finding exists to find).

- [ ] **Step 3: Implement `extractFieldTokens`**

In `src/pageCompare.js`, find the `TOKEN_PATTERNS` array declaration:

```js
const TOKEN_PATTERNS = [
```

Insert this new function and pattern directly above it (after `extractMoneyTokens` ends, before the `// Order matters` comment):

```js
// A "Label : Value" line -- see docs/superpowers/specs/
// 2026-08-25-labeled-field-comparison-design.md. Not a TOKEN_PATTERNS entry:
// each match's identity comes from what it captures (a single fixed 'field'
// class, not one class per label -- the record/photo value pair a finding
// already shows makes which field it is obvious in context), the same
// reason money gets its own extraction function instead of a pattern entry.
//
// [-_.\s]{0,10} before the colon absorbs a real artifact: every one of 6
// genuine calibration photos read a fill-in-blank before the colon as a
// stray character ("Proponent _: Northern Luzon..."). The record's own PDF
// text never needs this, but applying it to both sides is simpler and no
// less safe than special-casing one.
const FIELD_LINE = /^\s*[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2}\s*[-_.\s]{0,10}:\s*(.+?)\s*$/;

// Runs after every other class, including 'name' inside the TOKEN_PATTERNS
// loop below -- see extractTokens, which calls this last. If a value is an
// ALL-CAPS run 'name' already claimed (a company name, say), the matched
// span is NUL-masked by the time this sees it; rather than emit a token
// built from masked characters, this bails on the whole line and leaves the
// value as the name token it already became. A shape this can't cleanly
// use is invisible to it, not an error -- same fail-safe posture as every
// other extraction function in this file.
function extractFieldTokens(text, claimed) {
  const rawLines = String(text ?? '').split('\n');
  const out = [];
  rawLines.forEach((raw, i) => {
    const line = stripFooter(raw);
    const masked = maskClaimed(line, claimed[i]);
    const m = FIELD_LINE.exec(masked);
    if (!m) return;
    const value = m[1];
    if (value.includes(NUL)) return;
    const start = masked.indexOf(value, m.index);
    claimed[i].push([start, start + value.length]);
    out.push({ cls: 'field', value, line: i + 1 });
  });
  return out;
}

```

Then find `extractTokens`:

```js
export function extractTokens(text) {
  // stripFooter canonicalizes whitespace, which would destroy line structure —
  // so split first and strip the footer per line, keeping line numbers intact.
  const rawLines = String(text ?? '').split('\n');
  const out = [];
  const claimed = rawLines.map(() => []);

  // Money first, same position it held inside TOKEN_PATTERNS before it moved
  // out to get its own structural filter -- see extractMoneyTokens above.
  out.push(...extractMoneyTokens(text, claimed));

  for (const [cls, re] of TOKEN_PATTERNS) {
    rawLines.forEach((raw, i) => {
      const line = stripFooter(raw);
      // Blank out what earlier (more specific) classes already claimed, so a
      // greedy pattern cannot run straight through a claimed span. Masking
      // rather than discarding the whole match: "Rule III ACME MINING CORP"
      // used to lose ACME MINING CORP entirely, because III is itself matched
      // by the name class, so the run spanned the citation and the whole match
      // was dropped for overlapping it. (A citation WITH digits never collides:
      // the name pattern cannot cross them.)
      const masked = maskClaimed(line, claimed[i]);
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(masked)) !== null) {
        // reference's shape is rigid enough (R + dash-delimited 1/4/6-length
        // groups) that an all-lookalike-letters match is effectively
        // impossible in real prose, but the same guard money already applies
        // to its own DIGITISH run is free insurance against a phantom token
        // built from zero real digits.
        if (cls === 'reference' && !hasRealDigit(m[0])) continue;
        claimed[i].push([m.index, m.index + m[0].length]);
        out.push({ cls, value: m[0], line: i + 1 });
      }
    });
  }
  return out.sort((a, b) => a.line - b.line);
}
```

Change the last part (after the `for` loop) to:

```js
  for (const [cls, re] of TOKEN_PATTERNS) {
    rawLines.forEach((raw, i) => {
      const line = stripFooter(raw);
      // Blank out what earlier (more specific) classes already claimed, so a
      // greedy pattern cannot run straight through a claimed span. Masking
      // rather than discarding the whole match: "Rule III ACME MINING CORP"
      // used to lose ACME MINING CORP entirely, because III is itself matched
      // by the name class, so the run spanned the citation and the whole match
      // was dropped for overlapping it. (A citation WITH digits never collides:
      // the name pattern cannot cross them.)
      const masked = maskClaimed(line, claimed[i]);
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(masked)) !== null) {
        // reference's shape is rigid enough (R + dash-delimited 1/4/6-length
        // groups) that an all-lookalike-letters match is effectively
        // impossible in real prose, but the same guard money already applies
        // to its own DIGITISH run is free insurance against a phantom token
        // built from zero real digits.
        if (cls === 'reference' && !hasRealDigit(m[0])) continue;
        claimed[i].push([m.index, m.index + m[0].length]);
        out.push({ cls, value: m[0], line: i + 1 });
      }
    });
  }

  // Last of all -- a labeled field's value is whatever's left on its line
  // once every more specific class has already claimed its own span.
  out.push(...extractFieldTokens(text, claimed));

  return out.sort((a, b) => a.line - b.line);
}
```

- [ ] **Step 4: Add `field` to `STRICT`**

Find:

```js
const STRICT = new Set(['money', 'date', 'duration', 'reference', 'citation']);
```

Replace with:

```js
const STRICT = new Set(['money', 'date', 'duration', 'reference', 'citation', 'field']);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/pageCompare.test.js`
Expected: all tests pass, including every new one from Step 1.

- [ ] **Step 6: Run the whole suite**

Run: `node --test 'test/*.test.js'`
Expected: every test passes. (No existing fixture anywhere in the suite contains a `Label : Value`-shaped line outside `pageCompare.test.js`'s own new fixtures — checked directly before writing this plan.)

- [ ] **Step 7: Commit**

```bash
git add src/pageCompare.js test/pageCompare.test.js
git commit -m "$(cat <<'EOF'
feat(ocr): compare labeled Label:Value fields as a new strict class

Two live-tested alterations (Corporation->Corporations, Area->Areas)
sit in ordinary sentence-case text no existing token class covers.
extractFieldTokens runs last, after every other class including name,
and folds through foldGlyphs + foldLetterNoise (Task 1) before
comparing -- proven against real genuine-photo noise (Category B/8,
Fernando/Femando) rather than assumed safe. field joins STRICT;
compare()'s existing pairing, missing/added, and reasonFor logic
needed no changes at all.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Verify against real photos, close out the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-08-25-labeled-field-comparison-design.md` (status line only)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing — verification-only task.

- [ ] **Step 1: Run the whole suite one more time**

Run: `node --test 'test/*.test.js'`
Expected: every test passes.

- [ ] **Step 2: Run the real-photo calibration**

Run: `node scripts/ocr-calibrate.mjs scripts/print-test-sealed.pdf test/fixtures/pages`

Expected:
- Criterion 1: 10 genuine pages, 0 with material findings — unchanged. This is the check that actually confirms §4's folding claim against real photos, not just the synthetic tests above: if `Category B`/`8` or `Fernando`/`Femando` still produced a material finding on the real `1-genuine-c.jpg` or `1-genuine-e.jpg` fixtures, this criterion would catch it even if every unit test passed.
- Criterion 4: `1-altered.jpg` still exactly 1 material finding (the known `R1-2026-010734 -> R1-2026-010784` reference alteration) — unchanged; this feature adds a new class, it doesn't touch reference comparison.

If criterion 1 fails: stop, do not proceed to Step 3. That means real photo data disagrees with the synthetic tests in Task 2 — investigate which real photo and which field before closing this out, the same discipline every prior false-positive in this feature has followed.

- [ ] **Step 3: Update the spec's status line**

In `docs/superpowers/specs/2026-08-25-labeled-field-comparison-design.md`, change:

```markdown
**Status:** Approved design, pre-implementation
```

to:

```markdown
**Status:** Implemented and verified against real photos (2026-08-25) — see the calibration run in Task 3 of the implementation plan.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-25-labeled-field-comparison-design.md
git commit -m "$(cat <<'EOF'
docs(ocr): mark the labeled-field comparison design as implemented

Verified against the real committed calibration photos: 10 genuine
pages still show zero material findings (confirming the fold-based
tolerance holds against real noise, not just the synthetic
regressions), and the known alteration is still caught.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
