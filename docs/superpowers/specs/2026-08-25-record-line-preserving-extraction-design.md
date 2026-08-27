# Page Image OCR — A Line-Preserving Record Extraction for Comparison — Design

**Date:** 2026-08-25
**Status:** Approved design, pre-implementation
**Extends:** `2026-08-13-page-image-ocr-design.md`, `2026-08-24-ocr-footer-position-design.md`

## 1. Problem

`extractPageTexts()` (`src/pdfTools.js`) joins every text item pdf.js reports
with a single space, discarding line structure completely. That is correct
and load-bearing for its actual job: it feeds `sealer.js`'s sealing digest,
and a digest must be computed the same way every time — it cannot depend on
a decision about where lines "should" go.

The OCR page-image comparison feature (`src/verifyPageImage.js`) reuses this
same flattened text as its authoritative side, `authText`, passed into
`compare()` (`src/pageCompare.js`). But a real photo's OCR reading (Tesseract)
*does* preserve real line breaks — and `pageCompare.js`'s `extractTokens()`
has always processed text per line (`String(text).split('\n')`), a design
that assumed line-structured input on both sides from the start. In
practice only the photo side ever had it. The record side has been one
giant single "line" for every page, for the entire life of this feature.

Two real bugs, found by live-testing on real printed pages this session,
trace directly to that mismatch:

- **Over-merging** (fixed 2026-08-24, `feat(ocr): cap the name pattern...`):
  with no boundary at all, the record's flattened text let the ALL-CAPS name
  pattern run straight across what were genuinely two separate printed
  title lines, producing a false "difference" against the photo's correctly
  separate two lines. Patched with an arbitrary 6-word cap — the longest
  genuine single name observed in this project's documents, not a rule
  derived from anything structural.
- **Under-matching** (fixed 2026-08-24, `fix(ocr): stop flagging a title
  split by a real page wrap...`): the reverse case. A title that is one
  line in the (line-break-free) record wraps across two real printed lines
  on the actual page. Tesseract's per-line extraction can't see across that
  wrap, so if the trailing word lands alone on its own line it fails the
  name pattern's 2-word minimum and never becomes a token at all — the
  photo's reading is a truncated, but genuine, prefix of the record's
  value. Patched with a dedicated `isWrapPrefix` tolerance check.

Both patches are correct and stay. But they are two symptoms of one cause,
and the cause is still there: the record side has no line information, so
any name that spans what the *physical page* treats as a line boundary has
to be handled as a special case, one shape at a time, in the *comparison*
logic. This design removes the cause for the comparison path specifically,
without touching the digest path at all.

## 2. What this changes, and what it deliberately doesn't

pdf.js — already a dependency, already the library `extractPageTexts` calls
— reports an `item.hasEOL` boolean on every text item from
`getTextContent()`: true when that item is immediately followed by a line
break in the PDF's own text flow. This is not a heuristic to reconstruct;
it is a field pdf.js already computes and `extractPageTexts` already
discards.

This design adds a second extraction function that keeps it, used **only**
by the OCR-comparison path. `extractPageTexts()` itself does not change in
any way — same signature, same join rule, same output, byte-for-byte, for
every existing caller (`sealer.js`'s digest, `docVerifier.js`,
`app.js`'s control-number lookup). Nothing about sealing changes.

## 3. Where it sits

```
pdfTools.js
  getPageItems(bytes)  [NEW, internal — the shared PDF-load/iterate step]
       │
       ├──► extractPageTexts(bytes)            [UNCHANGED signature & output]
       │      join every page's items with ' '
       │
       └──► extractPageTextsWithLines(bytes)   [NEW]
              same items, joined pairwise: between item[i] and item[i+1],
              insert '\n' if item[i].hasEOL is true, else ' ' -- no
              separator after the last item, same as Array.join today

verifyPageImage.js
  authText = (await extractPageTextsWithLines(bytes))[k - 1]
  -- the only call site that changes, anywhere in the codebase --

pageCompare.js — NOT MODIFIED by this design, except the two token-pattern
  edits in §4 below. extractTokens() already splits authText and ocrText on
  '\n' identically; it was written assuming both sides had it.
```

`sealer.js`, `docVerifier.js`, and `src/app.js`'s control-number detector
keep calling `extractPageTexts` exactly as before. `getPageItems` is not
exported; it exists purely so the two public functions share the
PDF-loading boilerplate instead of duplicating it, each supplying only its
own join rule.

## 4. `pageCompare.js`: what real line boundaries make obsolete

**The 6-word name-pattern cap is removed.** It was a stand-in for a
structural boundary this design now provides directly. Keeping it
alongside real line info would be actively wrong, not just redundant: a
genuine single printed line naming something longer than 6 words would be
wrongly truncated into two pieces, exactly the bug this whole feature
exists to avoid. The pattern reverts to unbounded:

```js
['name', new RegExp(String.raw`\b[A-Z][A-Z&.'-]+(?:\s+[A-Z][A-Z&.'-]+)+\b`, 'g')],
```

The real line boundary (now present on both sides) is what stops a name
run — not a word count.

**`isWrapPrefix` (2026-08-24) is kept, unchanged, as a backstop.** Real
line boundaries fix the general case — a title that wraps in the PDF the
same way it wraps on the physical page will now match cleanly on both
sides with no truncation. But the PDF's line layout and the physically
printed page are not *guaranteed* identical: print-time font substitution,
DPI scaling, or margin differences could still shift a wrap point in a way
the PDF itself never anticipated. `isWrapPrefix` costs nothing (tolerant
class only, never material either way) and catches exactly that residual
case if one ever shows up.

Nothing else in `pageCompare.js` changes. `similarity()`'s page-identity
check (`THRESHOLDS.samePageMin`) is unaffected: `normalizeWords()` splits
on `/\s+/`, which already treats `\n` as ordinary whitespace. `stripFooter`
/ `FOOTER_RE` (`src/sealCode.js`) is unaffected structurally: no `^`/`$`
anchors, `\s*` between every component, called per-line inside
`extractTokens()` exactly as today — it now simply receives a shorter,
cleaner single real line instead of a fragment of one enormous flattened
string, which if anything reduces the chance of adjacent unrelated text
interfering with the shape match. This is asserted, not just assumed — see
§6.

## 5. Testing

- **`extractPageTextsWithLines` unit tests**, against a small real or
  hand-built PDF: confirm line breaks land exactly where `hasEOL` says
  they should, and that `extractPageTexts`'s own output is provably
  unchanged (same bytes in, same flattened string out, before and after
  this change).
- **`pageCompare.test.js`'s title-merge test is replaced, not deleted.**
  The existing test exercises the removed cap directly (two ALL-CAPS runs
  adjacent in one artificially flattened string). Its replacement
  constructs the same real two-title case as genuinely line-broken input
  (`'TITLE ONE\nTITLE TWO'`) and confirms `extractTokens` still keeps them
  separate — now because of the line boundary, not the cap.
- **The wrap-prefix test (2026-08-24) is kept as-is** — it already
  constructs its input as genuinely line-broken, so it continues to
  exercise the backstop correctly and needs no change.
- **Full suite**, then **`scripts/ocr-calibrate.mjs` against every real
  committed photo in `test/fixtures/pages`** — the same real-data
  discipline every OCR change in this feature has followed. This is the
  check that actually confirms §4's footer-stripping claim, not just the
  reasoning behind it: zero material false positives on the 10 genuine
  pages, the one known alteration still caught, before this is considered
  done.

## 6. Honest limits

- **This does not guarantee every wrap mismatch disappears** — only that
  the common case (PDF and print agree on where lines break, which they
  should for a template rendered specifically to be printed) now matches
  structurally instead of by heuristic. `isWrapPrefix` remains the backstop
  for the cases it doesn't cover; this design does not claim to close that
  gap fully, only to shrink how often it needs to.
- **`hasEOL` reflects pdf.js's interpretation of the PDF's own text flow,
  not a guarantee about the physically printed page.** If the PDF used to
  seal a document were ever generated with different line-wrap behavior
  than what actually gets printed (a font substitution at print time, a
  scaled print job), `hasEOL` would still faithfully report the PDF's own
  layout — it just wouldn't match paper in that instance. This is the same
  class of limit `isWrapPrefix` already exists to catch, not a new one.
- **`getPageItems` is not exported.** If a third consumer ever needs
  line-aware record text, it should import `extractPageTextsWithLines`,
  not reach past it — keeping exactly one function per shape of output,
  same discipline as the footer-position design's stated preference for a
  new, separate mechanism over a shared one when two sides' needs differ.

## 7. Out of scope

- **Any change to `extractPageTexts()`'s output, signature, or callers.**
  `sealer.js`'s digest, `docVerifier.js`, and `app.js`'s control-number
  lookup are unaffected by this design in every respect.
- **Any change to `stripFooter()` / `FOOTER_RE`** (`src/sealCode.js`).
  Both stay exactly as reviewed, per every prior design in this feature.
- **Reconstructing line breaks via text-item y-position clustering**
  (the technique `src/ocrFooter.js` uses on Tesseract words). Considered
  and rejected: pdf.js already computes and exposes exactly this
  information via `hasEOL`, more reliably than a coordinate heuristic
  could reconstruct it.
- **Removing or weakening `isWrapPrefix`.** Explicitly kept, per §4.
