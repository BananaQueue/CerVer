# Page Image OCR — Comparing Labeled Fields — Design

**Date:** 2026-08-25
**Status:** Revised after a first implementation failed real-photo verification — see §2a. Pre-implementation of the revision.
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

Both findings shaped the first implementation attempt: §3 (original)'s
extraction pattern absorbed the first; §4 reuses existing folds, unmodified,
to absorb the second. §2a records what real-photo verification found wrong
with that attempt, and §3 (below) describes the corrected mechanism.

## 2a. First attempt failed real-photo verification — a deeper root cause

The first implementation (blind `label\s*[-_.\s]{0,10}:\s*value` regex, run
identically on both sides) passed every synthetic unit test but failed
`scripts/ocr-calibrate.mjs`'s criterion 1 against the real fixtures: 4 of 10
genuine pages produced material false positives, all `field ... -> null
(missing)`. Checking the same field lines across all 6 genuine page-1
photos (not just the 2 checked while designing the first attempt) found the
colon itself is not a reliable anchor at all — four distinct real shapes,
not one:

```
1-genuine-b.jpg:  "Location Barangay Poblacion..."     -- colon dropped entirely
1-genuine-b.jpg:  "Capacity + 120,000..."               -- colon misread as "+"
1-genuine-e.jpg:  "Proponent — : Northern..."           -- em-dash, space, colon
1-genuine.jpg:    "Proponent —_: Norther Luzon..."      -- em-dash, underscore, colon
```

Widening the pre-colon character class (to include the em-dash/en-dash
range `PUNCT_FOLD` already treats as a dash elsewhere in this file) would
fix the second pair of shapes but not the first: there is no colon at all
to anchor on in `"Location Barangay Poblacion..."` or `"Capacity +
120,000..."`. No single character class closes all four shapes, because the
underlying assumption — that a colon (in some recognizable form) always
survives — is false on this document's small-font label lines.

There was also a second, independently-discovered gap in the first
attempt's `1-altered.jpg` result: with real photo noise, more than one
record-side field could fail to find *any* unclaimed photo-side field
token to pair with, and the nearest-by-line-distance fallback every other
`STRICT` class already uses paired a record field with a photo field from a
*different label entirely*, reporting a nonsensical mismatched value. Every
other `STRICT` class is self-describing by shape (a date looks like a date,
a reference looks like a reference), so this cross-field confusion never
came up before `field` — multiple different labels sharing one generic
class was fine for materiality, but not for the nearest-token fallback that
only runs when an exact key match fails.

## 3. Extraction — record-driven, not blind-symmetric

Both gaps trace to the same design mistake: treating `field` like every
other class, extracted identically and independently on both sides. A
label is always clean on the record side (real PDF text, never garbled);
only the photo side is unreliable, and only the *punctuation between* label
and value, never the label word itself. So extraction stops being
symmetric:

**Record side** (`extractFieldTokens(text, claimed)`, no known labels):
runs the same shape as before —

```
^\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\s*[-_.\s]{0,10}:\s*(.+?)\s*$
```

Group 1 (label) and group 2 (value) are both captured now — group 1 feeds
straight into `compare()`'s label collection below; only group 2 becomes
the token's `value`. This blind regex is also the only path available when
`extractTokens` is called on a single string in isolation (unit tests, or
any caller with no known labels yet) — it is not removed, only
supplemented.

**`compare()`** collects the distinct labels found in the *record's* field
lines (a small helper over the same regex, not a new mechanism) and passes
them into the *photo*-side call: `extractTokens(ocrText, { fieldLabels })`.

**Photo side, when `fieldLabels` is supplied:** for each known label, in
whichever line the (masked) text starts with that label as a whole word —
`Project` must not match inside `Projections`, checked by requiring the
character immediately after the label to not be a letter — everything
after the label has its leading separator noise stripped
(`[\s:;+_.\-` plus the em-dash/en-dash range`]*`, zero or more) and
whatever remains is the value. This never requires a colon to exist at
all, which is what actually failed in §2a: it uses the label as the
anchor, not the punctuation after it. Traced through all four real shapes
in §2a plus the two already-working ones from §2, all six resolve
correctly.

`extractTokens`'s signature becomes `extractTokens(text, opts = {})` with
an optional `opts.fieldLabels` — every existing single-argument call
(`ocrFooter.js`, every unit test, the record-side call in `compare()`
itself) is unaffected, since omitting it falls back to the blind regex
exactly as before.

Every match, either path, becomes a token `{ cls: 'field', value, line }` —
one class name for every labeled field found, not a class per label (see
§2a on why a per-label class doesn't actually solve the cross-field
confusion problem either, since the nearest-fallback pairing issue was
about *unclaimed tokens of the same class*, which a per-label class would
still be, just a smaller one per label — the real fix is that the
photo-side label match means a record field almost never needs the
nearest-fallback path at all anymore, having found its own labeled photo
line directly).

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
  `Propor.ent` instead of `Proponent` on the record side would fail this
  pattern's own extraction (no match at all) rather than being flagged as a
  difference. On the photo side, a misread label (`Pr0ponent`, say) simply
  fails to match any known label from the record and the field is silently
  not found there either — reported the same way as any other field the
  photo failed to capture, not as a special case. Same fail-safe posture
  as every other extraction pattern in this file: a shape it doesn't
  recognize is invisible to it, not an error.
- **The photo-side label match is still not infallible.** It removes the
  colon-reliability problem entirely, but a severely garbled capture could
  still misread a label itself past recognition, or run two field lines
  together. When that happens the field is reported missing (same as any
  other value the photo failed to carry) — not a crash, not a wrong pairing.
  §2a's cross-field-confusion bug specifically is closed, because a record
  field that finds its own labeled photo line no longer needs the
  nearest-unclaimed-token fallback that caused it.

## 7. Testing

Real-case-driven, matching this feature's established discipline:

- **The two genuine-page noise cases from §2, as regression tests**:
  `Category B` vs `Category 8`, and `Fernando` vs `Femando` — both must be
  forgiven, not reported.
- **The two real alterations this design exists to catch**: `Corporation`
  vs `Corporations`, and `Area` vs `Areas` — both must be material.
- **All four real photo-side shapes from §2a**, matched via a known label
  with no colon requirement: a dropped colon (plain whitespace), a colon
  misread as `+`, and both em-dash variants.
- **The word-boundary guard**: a known label (`Project`) must not match as
  a prefix of a longer, unrelated word (`Projections`) in otherwise ordinary
  prose.
- **A field value is never confused with a name.** A labeled field's value
  can itself be a run of capitalized words (a company name) — confirm
  `extractFieldTokens` and the `name` pattern don't double-claim or
  conflict on the same line.
- **`extractTokens` with no `fieldLabels` still finds the blind shape** —
  proves the single-argument call every existing caller uses is unaffected.
- Then, integration: full suite, plus a re-run of `scripts/ocr-calibrate.mjs`
  against every real committed photo, confirming zero new material false
  positives on the 10 genuine pages and that the known alterations are still
  caught cleanly (a single finding, not the scrambled cross-field mismatch
  §2a found) — the same close-out every prior change in this feature has
  had, and the check that actually caught §2a in the first place.

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
