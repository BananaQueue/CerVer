# Page Image OCR — Comparing Labeled Fields — Design

**Date:** 2026-08-25
**Status:** Approved design, pre-implementation
**Extends:** `2026-08-13-page-image-ocr-design.md`, `2026-08-25-tolerant-finding-confidence-filter-design.md`

## 1. Problem

Live-testing an altered photo twice surfaced the same real gap: deliberate
single-word edits inside ordinary sentence-case text — `Corporation` →
`Corporations`, `Area` → `Areas` — pass through completely undetected. Both
sit in `Label : Value` lines (`Proponent : Northern Luzon Aggregates
Corporation`, `Classification : Category B — Environmentally Critical
Area`). Every existing token class is either a fixed numeric/coded shape
(money, date, duration, reference, citation — strict, always material) or a
run of ALL-CAPS words (name — tolerant, never material). Ordinary
sentence-case prose, including these labeled fields, is never tokenized at
all, by original design (`2026-08-13-page-image-ocr-design.md` §5.4): *"Names
and headings are long, OCR poorly, and a wrong character in one is far more
often the camera than a forger."*

That reasoning holds for free-flowing prose. It does not automatically hold
for `Label : Value` lines specifically — they are short, have a predictable
shape to anchor tolerance on, and are exactly where both real alterations
landed. This design closes that one, narrower gap.

## 2. What the real data says before designing the mechanism

Before choosing a tolerance mechanism, the 6 already-committed genuine page-1
photos (`test/fixtures/pages/1-genuine*.jpg`) were checked directly for how
their `Label : Value` lines actually read. Two concrete problems, not
hypothetical ones:

1. **Extraction must tolerate a stray artifact between label and colon.**
   Every one of the 6 photos read `Proponent` as `Proponent _:` — the record's
   own PDF text has a plain space (`Proponent : Northern Luzon...`), so this
   is Tesseract misreading the form's printed fill-in blank/underline. A
   naive `label\s*:\s*value` pattern misses this field on every single
   genuine photo.
2. **Real OCR noise, twice as often as not, would be a false positive
   without folding.** Of the fields that *were* found, 3 of 6 genuine photos
   differed from the record: `Category B` → `Category 8` (twice) and
   `Fernando` → `Femando` (once). Both are exactly the confusion pairs
   already handled elsewhere in this codebase — `B→8` is already in
   `GLYPH_FOLD`, `rn→m` is already one of `foldNameNoise`'s folds. Naive
   exact-matching would have flagged all three as material false positives
   on genuine, untampered pages.

Both findings shape the design directly: §3's extraction pattern absorbs
the first; §4 reuses existing folds, unmodified, to absorb the second.

## 3. Extraction

A new function, `extractFieldTokens(text, claimed)` — a dedicated pass
alongside `extractMoneyTokens`, not a `TOKEN_PATTERNS` entry, because each
match's identity comes from what it captures (the label), not a fixed class
name the way `money`/`date`/etc. are. Per line:

```
^\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\s*[-_.\s]{0,10}:\s*(.+?)\s*$
```

- Group 1, the label: 1-3 Title-Case words (`Project`, `Proponent`,
  `Classification`).
- `[-_.\s]{0,10}` before the colon: absorbs the real artifact found in §2 —
  a misread fill-in-blank. The record's own text never needs this
  tolerance, but applying it symmetrically to both sides is simpler and no
  less safe than special-casing one side.
- Group 2, the value: everything after the colon, trimmed.

Every match becomes a token `{ cls: 'field', value, line }` — one class
name for every labeled field found, not a class per label (a specific field
name would need dynamic `STRICT`-set membership and per-label UI pills for
no real benefit; the record/photo value pair shown in a finding already
makes which field it is obvious in context).

Runs after every other extraction (money, date, duration, reference,
citation, name) and respects `claimed`, the same masking convention
`extractMoneyTokens` and the `TOKEN_PATTERNS` loop already share — so a
value that happened to also contain something another class already
claimed does not re-claim that span. See §6 for the one case this doesn't
fully resolve.

## 4. Tolerance: reuse, not reinvent

`keyFor` gets a `field` branch that folds through the same two fold steps
`name` already uses: `foldGlyphs` (single-character digit-lookalikes), then
the multi-letter folds currently living inside `foldNameNoise`
(`rn→m`, `cl→d`, `vv→w`). Those folds are pulled into their own function —
`foldLetterNoise`, called by both the `name` and `field` key paths — rather
than duplicated. `foldNameNoise` itself is retired as a name (it becomes
`foldGlyphs` composed with `foldLetterNoise`, unchanged in behavior, just no
longer implying it is name-only).

This directly matches §2's data: folding `Category B` and `Category 8` both
land on the same key (`GLYPH_FOLD` already maps `B→8`); folding `Fernando`
and `Femando` both land on the same key (`rn→m` already does this). Neither
`Corporation`/`Corporations` nor `Area`/`Areas` collide after folding —
folding only ever maps specific character *sequences* onto others, it never
adds or removes a character, so a pluralization survives as a real,
reportable difference.

## 5. Materiality

`field` joins `STRICT`. Same never-forgive philosophy as the governing digit
rule (`2026-08-13-page-image-ocr-design.md` §5.4): whatever survives folding
is reported, with no further tolerance. `compare()`'s existing STRICT-class
pairing, missing/added logic, and `reasonFor` all apply unchanged — `field`
needs no new reason code; `reasonFor` already degrades to `'text'` when
`digitsOf` finds nothing to compare, which is the correct, existing behavior
for a corporate name or address with no digits in it at all.

## 6. Honest limits

- **A labeled field's value overlapping another class's span is not fully
  resolved.** If a value ever legitimately contained something already
  claimed by an earlier class (a date, a citation), `extractFieldTokens`
  would see a partially masked line and could produce an odd or truncated
  value. No real document seen in this project's fixtures does this — every
  labeled field observed so far (project name, proponent, location,
  capacity, classification) is plain descriptive text. Accepted, not solved;
  revisit if a real document's field value ever collides with another
  class.
- **Only `Label : Value` lines are covered.** Free-flowing prose paragraphs
  (`"This certifies that the proposed undertaking..."`) remain completely
  untokenized, per the original design's own reasoning in §1 — this design
  does not revisit that boundary, only the narrower one around labeled
  fields.
- **The label itself is not compared, only the value.** A label reading
  `Propor.ent` instead of `Proponent` would fail this pattern's own
  extraction (no match at all) rather than being flagged as a difference —
  the same fail-safe posture every other extraction pattern in this file
  already has: a shape it doesn't recognize is invisible to it, not an
  error.

## 7. Testing

Real-case-driven, matching this feature's established discipline:

- **The two genuine-page noise cases from §2, as regression tests**:
  `Category B` vs `Category 8`, and `Fernando` vs `Femando` — both must be
  forgiven, not reported.
- **The two real alterations this design exists to catch**: `Corporation`
  vs `Corporations`, and `Area` vs `Areas` — both must be material.
- **The underscore-before-colon extraction case** from §2 — a field must
  still be found and correctly extracted when the artifact sits between the
  label and the colon.
- **A field value is never confused with a name.** A labeled field's value
  can itself be a run of capitalized words (a company name) — confirm
  `extractFieldTokens` and the `name` pattern don't double-claim or
  conflict on the same line.
- Then, integration: full suite, plus a re-run of `scripts/ocr-calibrate.mjs`
  against every real committed photo, confirming zero new material false
  positives on the 10 genuine pages and that the known alterations are still
  caught — the same close-out every prior change in this feature has had.

## 8. Out of scope

- **Free-flowing prose paragraphs.** Named as a limit in §6, not attempted
  here.
- **Per-label class names or UI treatment.** A single `field` class is
  enough; see §3's reasoning.
- **Any change to `GLYPH_FOLD`, `stripFooter`/`FOOTER_RE`, or any existing
  `STRICT` class's pattern.** This design only adds a new class and
  generalizes one existing helper's name (`foldNameNoise` →
  `foldGlyphs` + `foldLetterNoise`); nothing already reviewed changes
  behavior.
