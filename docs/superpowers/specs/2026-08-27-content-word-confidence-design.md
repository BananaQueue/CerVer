# Page Image OCR — Content-Word Confidence — Design

**Date:** 2026-08-27
**Status:** Approved design, pre-implementation
**Extends:** `2026-08-13-page-image-ocr-design.md`

## 1. Problem

A real photo (page 2 of a "Special Order" memo, control `R1-2026-001024`)
was rejected as `image_unreadable` — `meanConfidence` measured `0.62`,
below `MIN_CONFIDENCE` (`0.65`). Retaking it several times produced the
same rejection every time. Checked directly against the actual OCR output:
the substantive content — a resource-persons list, a paragraph, a
signature, the footer reference — all read cleanly. The low score came
from roughly 40 near-zero-confidence detections: bare punctuation marks
(`"`, `-`, `.`, `?`, `,`, `:`, `'`) that Tesseract scores near 0% almost
reflexively, plus a handful of noise fragments (`parsoaeecoiogs`, `«pa/a`)
picked up from background texture in the photo. None of that reflects
whether a human could read the page; `meanConfidence` — a straight average
of every detected "word," Tesseract's own `data.confidence` — treats it as
if it does.

## 2. What the real data says

Dropping words shorter than 2 alphanumeric characters (`/[a-zA-Z0-9]{2,}/`)
from the average, checked against the failing photo first, then the full
16-photo calibration set:

```
                          current   content-only
failing photo              0.620        0.697   <- crosses the 0.65 gate
1-poor.jpg (real poor)     0.550        0.576   <- still below it
2-poor-b.jpg (real poor)   0.470        0.514   <- still below it
genuine floor (11 samples) —            0.750
2-poor.jpg (Deep Fusion)   0.740        0.763   <- still indistinguishable
3-poor.jpg (Deep Fusion)   0.760        0.834      from genuine (unchanged,
                                                     already-accepted limit)
```

Content-only confidence rescues the failing photo specifically, while the
two genuinely-degraded poor captures stay clearly below the genuine floor
— the gap actually widens (poor ceiling of the *real* degraded samples,
0.576, vs. genuine floor 0.750) rather than narrowing. The Deep
Fusion-rescued poor captures remain impossible to distinguish from genuine
by confidence alone — the same limitation `MIN_CONFIDENCE`'s own comment
already documents, not something this design changes either way.

`MIN_CONFIDENCE = 0.65` is kept unchanged: it already sits with margin on
both sides of the newly-measured gap (+0.074 above the real-poor ceiling,
-0.10 below the genuine floor). Reused deliberately, not left stale — its
comment is updated to record what it's now measured against.

## 3. What this changes

`src/ocr.js`'s `recognize()` currently returns Tesseract's own
`data.confidence` as `meanConfidence`. A new local helper computes it
instead, from the same `words` array `recognize()` already builds:

```js
function contentConfidence(words, data) {
  const contentWords = words.filter((w) => /[a-zA-Z0-9]{2,}/.test(w.text));
  if (contentWords.length === 0) {
    return Number.isFinite(data?.confidence) ? Math.min(1, Math.max(0, data.confidence / 100)) : 0;
  }
  return contentWords.reduce((sum, w) => sum + w.confidence, 0) / contentWords.length;
}
```

Falls back to Tesseract's own page-level average when there are zero
content words at all (a blank or fully illegible capture) — there is
nothing to average over otherwise, and returning `0` would make "read
fine, just no content words" look identical to "read nothing," which is
not the same failure `image_unreadable` is meant to describe.

`words` (already returned, already used by `locateFindings`/box-drawing)
is unaffected — this only changes what `meanConfidence` measures, not the
word list itself. `wordCount` (used by `THRESHOLDS.minWords`) is also
unaffected: it counts flattened `.text` tokens, a different, unrelated
measure.

## 4. Testing

- **The exact regression this design fixes**: the real failing photo,
  checked directly (not added to `test/fixtures/pages/` — it comes from a
  different source document, a "Special Order" memo, not
  `scripts/print-test-sealed.pdf`, so it can't join that fixture set
  without a mismatched reference page), now reads above `MIN_CONFIDENCE`.
- **`contentConfidence` in isolation**: a word list mixing high-confidence
  content words with near-zero punctuation returns a mean over the content
  words only, not dragged down by the punctuation.
- **The zero-content-words fallback**: an all-punctuation/no-content word
  list falls back to the page-level average rather than dividing by zero
  or silently returning a misleading `0`.
- Then, integration: full suite, plus a re-run of `scripts/ocr-calibrate.mjs`
  against every real committed photo (now including the new fixture),
  confirming the two genuinely-poor captures still land in
  `image_unreadable` and every genuine page still holds at zero material
  false positives — criteria 1 and 3 are the ones this change could
  plausibly disturb; both must hold exactly as before.

## 5. Honest limits

- **Does not touch the Deep Fusion limitation.** `2-poor.jpg` and
  `3-poor.jpg` remain readable-looking by this metric too, for the same
  reason `MIN_CONFIDENCE`'s original comment already names: the capture
  phone's Deep Fusion pipeline corrects deliberately degraded photos back
  toward legibility. This design changes what counts as noise within an
  otherwise-legible reading; it does not make confidence able to detect a
  photo Deep Fusion has already repaired.
- **The `/[a-zA-Z0-9]{2,}/` cutoff is a heuristic, not a calibrated
  threshold of its own.** It was chosen because it cleanly separates bare
  punctuation/single-character noise from real words in every sample
  checked, not derived from a measured gap the way `MIN_CONFIDENCE` itself
  is. If a future capture's noise pattern doesn't fit this shape, it may
  need revisiting.

## 6. Out of scope

- **Re-deriving `MIN_CONFIDENCE` to a different number.** Per §2, the
  existing value already sits correctly in the newly-measured gap.
- **`THRESHOLDS.minWords`**, `wordCount`, or anything about token
  extraction/comparison. This design touches exactly one thing: what
  `meanConfidence` measures.
- **The QR-code column-confusion issue** (a separate, already-documented,
  unsolved gap — see the dropped `2026-08-27-exif-rotation-correction-design.md`).
  Unrelated to this photo's rejection, which was a confidence-gate issue,
  not a segmentation one.
