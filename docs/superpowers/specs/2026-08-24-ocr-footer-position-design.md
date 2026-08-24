# Page Image OCR — Locating the Footer by Position, Not Shape — Design

**Date:** 2026-08-24
**Status:** Approved design, pre-implementation
**Extends:** `2026-08-13-page-image-ocr-design.md`, `2026-08-17-ocr-confidence-boxes-design.md`

## 1. Problem

Every sealed page prints its control number twice: once in the body ("Control
No. R1-2026-010734") and once in the footer stamp (`EMB · R1-2026-010734 ·
p2/3 · K1 · VHIF-AS2V`). `stripFooter()` (`src/sealCode.js`) removes the
footer's copy before comparison by matching its exact printed shape, leaving
exactly one reference occurrence for `pageCompare.js` to work with. This
works reliably on the record side, because that text is exact PDF extraction
— never garbled.

On a real photograph, calibration (`docs/superpowers/plans/2026-08-13-page-image-ocr.md`
Task 8, run 2026-08-24) produced this OCR reading of a genuine, untampered
page's footer region:

```
4 7 Be R1-2026-010794 = 27> - tea
```

The structural markers — `EMB`, the `·` separators, `p2/3`, `K1`, the
seal-code shape — are destroyed, not merely noisy. `stripFooter()`'s regex
requires that whole shape to match, so it does not recognize this as a
footer at all. The reference digits happen to survive, misread by one
character (`010734` → `010794`), and reach `pageCompare.js` as ordinary body
content: a second `reference` token, unmatched against the record's one, and
reported `severity: material, reason: added` — a false positive on a
genuine, untampered page.

**Why the obvious fix doesn't work.** Making `stripFooter()`'s regex
tolerant of digit noise *within* an otherwise-recognizable shape would not
have caught this: the shape itself is gone, not just the digits inside it.
And forgiving a reference that merely resembles an existing one by edit
distance is not on the table at all — that is precisely the attack the
governing digit rule (spec `2026-08-13-page-image-ocr-design.md` §5.4)
exists to catch. There is no textual test that distinguishes "this second
reference is the same footer stamp, misread" from "this second reference is
a genuinely altered one, planted nearby" — both look like a reference that
differs from the known-good one by a digit.

## 2. What this fixes, and the trade it makes

The only signal that distinguishes the two cases is **position**, not text:
a footer is always the printed page's bottommost line, by construction — the
sealer stamps it there, on every page, unconditionally. This design uses
that structural fact directly, identifying the footer candidate by where it
sits rather than what it says, using bounding-box data Tesseract already
computes (and which the confidence-boxes feature, `2026-08-17`, already
surfaces from `recognize()`).

**This creates one, narrow, always-present blind spot**, stated plainly
because it is binding on everything below: whatever text occupies a page's
bottommost recognized line is excluded from this comparison, regardless of
its content, whenever that line also looks footer-shaped (§4's content
gate). Content actually planted at that exact position could, in principle,
escape this specific check.

This is accepted, not overlooked, for two reasons. First, the alternative —
leaving the false positive in place — costs real trust in the feature every
time a genuine page happens to misread its footer, which calibration shows
is not rare. Second, and more fundamentally: this feature is explicitly
evidence, not proof (`2026-08-13-page-image-ocr-design.md` §2). The seal
itself — checked first, separately, before this feature ever runs — is what
actually proves a page's content has not changed, because the seal's HMAC
is computed over a digest of the real page content. Retyping any body text,
anywhere on the page including its last line, produces a page whose content
digest no longer matches its printed seal, which is a failure this feature
never has to catch because the seal check already caught it. What this
feature exists to catch is the one gap the seal cannot close on its own: the
seal is checked against paper that cannot be re-hashed, so a forger who
manages to reproduce a **valid** seal on an altered page (by whatever means)
is outside both this feature's and the seal's reach in the same way. The
blind spot this design accepts is narrower than that: it is one line, in a
fixed and known position, on pages whose seal has already verified.

## 3. Where it sits

```
recognize()                 stripOcrFooter()          compare()          locateFindings()
[src/ocr.js]                 [src/ocrFooter.js, NEW]    [src/pageCompare.js]  [src/ocrRegions.js]
     │                            │                         UNCHANGED            │
     ├─ text ────────────────────►│                              │               │
     │                            ├─ cleanedText ───────────────►│               │
     └─ words: [{text,            │                              ├─ report ─────►│
        confidence, bbox}] ───────┘                              │               │
                                                                   │        (full, uncut words,
                                                                   │         unaffected by this)
```

`stripOcrFooter()` sits strictly between `recognize()` and `compare()` — the
mirror image of `locateFindings()`, which sits strictly after `compare()`.
Same seam, opposite side. `compare()` in `src/pageCompare.js` is **not
modified in any way** by this design. `locateFindings()` continues to
receive the full, uncut `read.words` — it is only looking up positions for
whatever findings `compare()` already produced, so a line excluded from
comparison simply never produces a finding for it to look up in the first
place. Nothing here requires touching that module either.

## 4. `stripOcrFooter()`

```js
// src/ocrFooter.js
stripOcrFooter(text, words) => string
```

**Revised during implementation, twice, against real photo data — both
revisions kept because the reasoning matters as much as the result.**

1. **Cluster `words` into lines by vertical position.** Group words whose
   bounding-box vertical centers fall within a tolerance of each other,
   where the tolerance is derived from the **median word height** across the
   page (roughly half a line-height) rather than a fixed pixel count — a
   photo's absolute resolution varies by phone and distance, so a fixed
   pixel tolerance would be wrong at some scale. Median height is a stable,
   scale-relative proxy for what "one line" means on this specific photo.
   **Each cluster's words are then re-sorted left-to-right by x-position**
   before being used for anything else. Grouping by y produces clusters in
   y-sort order, not reading order — real OCR words on the same visual line
   essentially never share an exact y-center (character-height/baseline
   jitter), so left uncorrected this silently scrambled word order within a
   line. The unit test fixtures originally gave every word on a synthetic
   line the identical y-coordinate, which hid this completely (a stable sort
   over equal keys preserves input order by coincidence) — it surfaced only
   against a real photo, where removal was a silent no-op with no signal
   anything had gone wrong. Fixtures now apply small deterministic y-jitter
   per word specifically so this class of bug cannot hide again.
2. **The candidate is not simply the single bottommost cluster.** A real
   photo showed OCR-read content genuinely *below* the footer's own text —
   stray symbol fragments read out of the pixelated seal-mark graphic
   printed near the stamp — so the true bottommost cluster was pure noise
   with no footer-shaped content at all, and the real footer sat one cluster
   above it. The search instead scans upward from the bottom, bounded to
   clusters whose vertical center falls in the **bottom quarter of the
   page's own vertical extent** (not a fixed pixel distance or cluster
   count — proportional, so it adapts to any page length or capture
   resolution), and takes the first one that passes the content gate below.
   A fixed *cluster count* was tried first in place of this proportional
   band and is explicitly wrong: on a short or sparse page it reaches all
   the way to a genuine top-of-page line, which this plan's own test suite
   caught before it reached a real photo.
3. **Content gate**, using `extractTokens()` — already exported from
   `src/pageCompare.js`, already reviewed, reused rather than reimplemented:
   the candidate line's joined text must contain at least one `reference` or
   `citation`-class token, **and zero `money`/`date`/`duration`-class
   tokens**. A real footer stamp never carries any of those; ordinary prose
   — including a page's genuine final sentence — often does. This is the
   condition that keeps the mechanism from ever touching a page whose last
   body line legitimately states an amount or a date. Every candidate
   examined within the bottom band gets this same, unweakened gate — the
   proportional band only controls how far up the search is allowed to look
   past pure noise, never what counts as footer-shaped once it's looking.
4. **If the gate passes**, remove that exact line's text — matched via a
   flexible-whitespace pattern built from the same (now reading-order)
   words, not an exact substring match, since Tesseract's own flat text may
   not join words with a single space the way this function's gate-check
   text does — and return the result. **If nothing in the bottom band
   passes**, return `text` completely unchanged — untouched is the default;
   exclusion is the narrow exception.
5. **No `words`, or nothing clusterable** (empty array, `undefined`, or
   every word on top of every other) → return `text` unchanged. Same
   fail-safe posture as `locateFindings()`: a data shape this function
   cannot use degrades to today's behavior, never an error, never a
   different comparison outcome than if this feature did not exist.

Wired into `src/verifyPageImage.js`, one line before the existing `compare`
call:

```js
const cleanedText = stripOcrFooter(read.text, read.words);
const report = compare(cleanedText, authText);
```

## 5. Testing

Pure function, `node:test`, fixed word-list fixtures — no OCR engine, same
discipline as `test/ocrRegions.test.js`.

- **The real failing case.** The actual garbled text pulled from
  `test/fixtures/pages/2-genuine-c.jpg` this session
  (`4 7 Be R1-2026-010794 = 27> - tea`), as a fixture with matching
  synthetic word positions. Confirm the phantom `reference: added` finding
  that this design exists to remove is gone once `stripOcrFooter()` runs
  ahead of `compare()`.
- **The gate correctly refuses a last line with a money, date, or duration
  value** — construct a fixture where the bottommost line is a genuine final
  sentence stating an amount, confirm nothing is excluded and that amount is
  still compared normally.
- **A genuine tamper elsewhere in the body is still caught** — confirm this
  mechanism cannot suppress a real finding anywhere except the one
  positionally-gated line.
- **Empty and missing `words`** — both return `text` byte-for-byte
  unchanged, no crash.
- **The accepted blind spot, made explicit as a passing test, not left
  implicit:** a fixture where a second, digit-substituted reference is
  deliberately placed in the bottommost-line position, shaped like a footer
  (reference-only, no money/date/duration). This test asserts the
  alteration is **not** caught — documenting the boundary this design
  accepts in §2, in code, rather than only in prose.

## 6. Honest limits

- **The blind spot in §2 is real and is not softened by anything in this
  design.** Content positioned in a page's bottom quarter, shaped like a
  footer stamp (reference-only, no money/date/duration), is excluded from
  this comparison regardless of what its digits actually say — the search
  band, not a single line, per §4.2.
- **Line clustering, and the bottom-band boundary itself, depend on OCR's
  own word positions being roughly sane.** A severely warped or folded
  photo could distort what counts as "the bottom quarter" — the band is
  computed from the min/max of every word's own bounding box, so one
  wildly misplaced outlier word could skew it. In that case the mechanism
  either misses the real footer (no worse than today) or, in a pathological
  case, clusters a genuine line together with the footer. The content gate
  (§4.3) is what limits the damage either way: a merged or misplaced
  cluster that also contains a money/date/duration token fails the gate and
  nothing is excluded.
- **This does not make `MIN_CONFIDENCE` or `THRESHOLDS.samePageMin` any
  more measured than the 2026-08-24 calibration already recorded them as.**
  Those remain exactly what that calibration run established (`samePageMin`
  measured from a real gap; `MIN_CONFIDENCE` conservative, not measured).
  This design only removes one specific, now-understood source of false
  positives from the genuine-page data those thresholds were calibrated
  against — it does not itself recalibrate anything, and the fixture set
  should be re-run through `scripts/ocr-calibrate.mjs` once this ships, to
  confirm the false positive is actually gone on the real photo, not just on
  a reconstructed fixture.

## 7. Out of scope

- **Any content-similarity-based forgiveness for reference tokens.**
  Considered and rejected in §1 — this is the exact attack the governing
  digit rule exists to catch, and no positional fix changes that reasoning
  for occurrences *outside* the gated last-line position.
- **Extending this mechanism to other token classes.** Money, date, and
  duration tokens are not known to double-print anywhere on these documents
  the way the control number does in the footer stamp, so there is no
  analogous problem to solve for them. If one is found, it gets its own
  design, not a silent extension of this one.
- **Touching `src/pageCompare.js` or `src/sealCode.js`'s `stripFooter()`/
  `FOOTER_RE`.** Both stay exactly as reviewed. The record side already
  works; the OCR side gets a new, separate mechanism rather than a shared
  one, because the two sides' failure modes are not symmetric — only the
  OCR side is ever garbled.
- **Re-deriving `MIN_CONFIDENCE`/`samePageMin` as part of this change.**
  Those are calibration's job (already run once, 2026-08-24), not this
  design's.
