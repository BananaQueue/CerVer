# Page Image OCR — Signatory Title Comparison — Design

**Date:** 2026-09-09
**Status:** Implemented and verified against 12 real photos across two
structurally different documents (2026-09-09). The blank-line boundary
this design originally proposed did not survive contact with real record
text at all — neither document's clean PDF text has a literal blank line
between the title and what follows it, so it swallowed page furniture
(a bare control number, a "Page N of M" line, an address) into every
title on both sides, turning every genuine photo into a false material
finding. Fixed by three combined stopping conditions instead of one: a
blank line, a line something else already claimed (this also fixed a
second failure — an ALL-CAPS document heading with no real signature on
that page, confirmed on `R1-2026-010734`'s own page 1, was false-firing
as the anchor), and a line without enough real-word content relative to
any digit it carries (a genuine page-number line has at most one real
word and is rejected; real title text that merely picked up a stray OCR
digit has two or more and survives — this exact shape is the real
altered photo that motivated this design, "4 Regional Director 4"). Full
trail in `extractSignatoryTitleToken`'s own comment
(`src/pageCompare.js`). `SIGNATORY_TITLE_SIMILARITY_FLOOR` (0.7) is a
measured value, not a guess: genuine photos clustered at 0.811-1.000,
the two real altered photos at 0.211-0.222.
**Extends:** `2026-08-13-page-image-ocr-design.md`,
`2026-08-25-labeled-field-comparison-design.md`

## 1. Problem

A real altered printed sheet of `sealed/R1-2026-020780.pdf` (page 1) kept
the signer's name intact but replaced their printed title:

- Record: `MS. MA. ISABEL O. PEREZ-MAMARADLO` / `Supervising Environmental
  Management Specialist,` / `Chief, Environmental Impact Assessment
  Section` / `In-Charge, Office of the Regional Director`
- Altered sheet: same name, then only `Regional Director`

Run through the shipped comparison, this produced **zero findings**
anywhere about the title. Not a bug in a class that was supposed to catch
it — nothing extracts or compares this text at all. Every existing class
needs a specific shape to fire (a date pattern, a money pattern, a
`Label:` line, a bulleted or numbered entry); free-flowing prose following
a signature has none of those shapes.

This is a real, high-stakes gap. The seal proves the page's *position* in
the document, explicitly not its wording (`Proves position, not wording`,
shown in the app's own verdict card) — a forged title is exactly the kind
of tampering this OCR-comparison feature exists to catch, because it
changes who the document claims signed with what authority, and the seal
by design says nothing about that.

## 2. What the real data says

Checked against a second, structurally different real document
(`sealed/R1-2026-010734.pdf`, an Environmental Compliance Certificate,
via `test/fixtures/pages/3-genuine.jpg`) before locking any extraction
rule — the same discipline `numberedItem`'s design required:

```
NOEL A. VILLANUEVA, CESO IV
Regional Director
```

This confirms the shape generalizes (a name line, ALL-CAPS, followed by a
title) but also that a fixed line count is wrong: the Special Order's
title runs **three** lines, this certificate's runs **one**. Any design
assuming a specific number of lines fails one of the two real documents on
hand.

In both documents, the signatory's printed name is the LAST `name`-class
token (the existing ALL-CAPS-run pattern, `TOKEN_PATTERNS`) before the
page ends — subject lines and headings occur earlier in the text, and
nothing else ALL-CAPS-shaped follows a signature block in either sample.
That makes the last `name` token a reliable anchor on both documents
without any new pattern.

**Not yet checked**: how this anchor and boundary rule behave on OCR'd
(noisy) text specifically for the *title* portion — only a plain,
non-adversarial OCR read of the second document's page 3 was checked
(§1's confirmation used the record PDF text directly for the first
document). Whether the blank-line boundary below survives real OCR noise
on either document is exactly what implementation's real-photo
calibration step needs to establish, per §5.

## 3. Extraction

A new class, `signatoryTitle`, extracted by a dedicated function run
**after** `name` tokens are known for that side's text (it needs them as
its anchor) — same ordering dependency `field` already has on nothing
else, but simpler: no cross-side coordination is needed for the anchor
itself, only optionally for the boundary (see below).

```js
function extractSignatoryTitleToken(rawLines, nameTokens) {
  if (nameTokens.length === 0) return null;
  const anchorLine = Math.max(...nameTokens.map((t) => t.line));
  const titleLines = [];
  for (let i = anchorLine; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (line === '') break;
    titleLines.push(line);
  }
  if (titleLines.length === 0) return null;
  return { cls: 'signatoryTitle', value: titleLines.join(' '), line: anchorLine + 1 };
}
```

Runs identically on both record and photo text (same function, same
rule) — no record-driven guidance planned for v1, unlike `field`'s
colon-loss problem. `field` needed the record's own labels to guide photo
extraction because its ANCHOR (a colon) was itself unreliable on a photo
(`"the colon itself turned out not to be a reliable anchor at all"`).
Here the anchor is the ALL-CAPS name pattern, which this project's own
extensive testing this session has already shown to be robust under real
OCR noise. Only the boundary (the blank line) is new and unverified — if
real-photo calibration during implementation shows the blank-line rule
itself is unreliable on noisy text (a stray OCR artifact landing on what
should be a blank line, the same class of problem `numberedItem` hit
three times), the fallback is exactly the pattern `field` already proved
out: extract the record's value first, then search the photo's text near
its own name anchor for a folded match, rather than trusting the photo
side to find its own boundary independently.

At most one `signatoryTitle` token per side, since both real documents
have exactly one signatory.

## 4. Matching and severity: a dedicated pass, not the generic key mechanism

Like `numberedItem`, this doesn't fit the generic key-based `compare()`
passes — there is no repeatable key to pair on, only "the document's one
signatory title, if any." A dedicated function, `compareSignatoryTitle`:

- **Both sides have a token, folded values are similar enough** (word-level
  overlap above a threshold, tolerant of individual OCR-noise words the
  same way other classes already are): no finding.
- **Both sides have a token, folded values differ materially** (the real
  case this design exists for — three lines collapsed into one entirely
  different word): `severity: 'material', reason: 'text'`.
- **Record has a token, photo doesn't** (anchor or boundary failed to
  extract on the photo side): `severity: 'tolerant', reason: 'missing'`.
  Deliberately tolerant, not material — this class is far wordier than a
  date or amount and structurally more exposed to an OCR dropout than any
  existing class; there is no positional/numeric cross-check the way
  `numberedItem`'s number gives it, so a bare absence can't be told apart
  from ordinary capture noise. Same reasoning `listItem`'s missing-entry
  handling already established.
- **Photo has a token, record doesn't**: no finding. Unlike every other
  STRICT class's "added" pass, there is no real record-side identity to
  compare against, and no evidence yet that this actually occurs on a
  real document (both samples have exactly one signatory, matched by the
  same anchor rule both sides). Treating an anchor-detection edge case as
  material tampering with nothing to point at would repeat the exact
  mistake the 2026-09-09 citation fix just corrected — a finding built
  on zero real corroborating evidence.

`STRICT` (the set governing the digit rule) does not gain `signatoryTitle`
— the digit rule is specifically about digit-count/digit-substitution
being unforgivable, and this class carries no digits at all. It is
material on genuine text divergence, same conceptual bar `numberedItem`
already applies for its own text-mismatch case.

## 5. Honest limits

- **The blank-line extraction boundary is unverified against real OCR
  noise.** Both real-document checks in §2 used either clean record text
  or a single plain photo read, not an adversarial altered-photo
  comparison. Implementation MUST calibrate this against real photos of
  both documents (at minimum: the existing `1-genuine.jpg` /
  `1-altered-b.jpg` / etc. set for `R1-2026-020780`, plus new captures of
  the title-replacement alteration itself) before shipping, and document
  whatever the real bounding-rule trail turns out to be — expect this to
  need revision, not to confirm the first draft.
- **A document with no `name`-class anchor extracts nothing.** Silent,
  not a false negative in the "should have caught this" sense — there is
  nothing to anchor on. A signature block using a non-ALL-CAPS name
  (should one exist on some other real document) is invisible to this
  design entirely.
- **Multiple co-signatories are not handled.** Neither real document has
  more than one signatory. Not building for a case with zero evidence
  (same call `numberedItem`'s design made about its own edge cases).
- **The similarity threshold for "materially different" is not yet a
  number.** Needs the same real-photo-measured treatment `MIN_CONFIDENCE`
  and `THRESHOLDS` already received — a specific value belongs in the
  implementation plan once real OCR readings of a genuine signatory title
  are available to measure normal noise against, not guessed here.

## 6. Out of scope

- **Signature *image* comparison.** Explicitly ruled out — sealing itself
  is the trust gate for a signature's authenticity; a forged signature
  image never produces a page with a valid seal, so there is nothing for
  OCR comparison to add. (User decision, 2026-09-09; see also the
  seal-endpoint-hardening plan noted the same day.)
- **The document's own identifying number** (e.g. "Special Order No.
  26-383") and other prose gaps identified in the same conversation
  (subject-line wording, conditions/provisos, addressee). Each is its own
  scoping question; this design covers the signatory title only, the one
  with demonstrated real evidence and the highest stated priority.
- **Record-driven (label-guided) photo extraction**, `field`'s fallback
  pattern — not built now; only adopted if real-photo calibration in §5
  shows the simpler same-function-both-sides rule fails.

## 7. Testing

- **Extraction**: a name anchor followed by a single title line; a name
  anchor followed by multiple title lines up to a blank line; no `name`
  token in the text extracts nothing; a title block running to literal
  end-of-text (no trailing blank line) is still extracted.
- **`compareSignatoryTitle`**: matching folded values (including minor
  OCR-style noise) → no finding; a genuine wholesale text replacement →
  material, reason `text`; record has a token and photo doesn't →
  tolerant, reason `missing`; photo has a token and record doesn't → no
  finding.
- **Real-photo calibration, required before implementation is considered
  done** (not optional, per §5): existing `R1-2026-020780` fixture set
  (`pages-special-order-383/`) — the genuine photos must show zero
  material `signatoryTitle` findings, and the real altered photos from
  2026-09-09 (the `Regional Director`-only sheet) must show a material
  finding on the title specifically. Second document
  (`R1-2026-010734`, `test/fixtures/pages/`) — its genuine photos must
  also show zero material `signatoryTitle` findings, confirming the
  one-line-title shape doesn't regress.
