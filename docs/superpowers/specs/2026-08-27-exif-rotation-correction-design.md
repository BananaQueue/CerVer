# Page Image OCR — Correcting EXIF-Rotated Captures Before OCR — Design

**Date:** 2026-08-27
**Status:** Scope narrowed after real-photo testing disconfirmed the original hypothesis — see §1a. Approved as a correctness fix in its own right, not as a fix for the garbling that motivated it.
**Extends:** `2026-08-13-page-image-ocr-design.md`

## 1. Problem

Live-testing a photo of page 2 produced 35 tolerant "differences put down to
the camera" — far more than any prior capture — including the record's
title (`DEPARTMENT OF ENVIRONMENT AND NATURAL RESOURCES`) reading back as a
fragment (`...RESOUR`). Checking the actual OCR output directly showed the
underlying problem is not a misread word at all: Tesseract's own per-word
confidence for "RESOURCES" was `0.96`, high. The raw text shows the *line
structure itself* scrambled —

```
Republic of the Philippines ND NATURAL RESOURCES
NT OF ENVIRONMENT A
...NT BUREAU — REGIONAL OFFICE NO. |
ENVIRONMENTAL MANAGEME
```

— fragments of the same physical title line merged onto different reported
lines, and split onto others. No mechanism in this feature targets that:
`isWrapPrefix` (2026-08-24) handles a whole word missing at a line-wrap
boundary; the confidence filter (2026-08-25) handles a low-confidence
reading. Neither applies here — the word itself read fine, the *line
segmentation* was wrong before any token extraction began.

**Root cause, confirmed directly against the uploaded photo's bytes:** its
JPEG `EXIF Orientation` tag is `6` (rotate 90° clockwise for display). The
phone stored the sensor's raw (sideways) pixel data and tagged it for
viewers to rotate — standard behavior, not a user error. Browsers respect
that tag when decoding `<img>`/canvas (which is why the photo displays
upright in every screenshot), but `src/ocr.js`'s `recognize()` passes the
raw file bytes straight to Tesseract with no EXIF handling at all:

```js
const { data } = await w.recognize(Buffer.from(imageBytes), {}, { blocks: true });
```

Tesseract's layout analysis sees the physically-sideways pixel data. The
hypothesis: a full 90° misorientation confuses its line/paragraph
segmentation, worst in the dense title block. Every calibration photo so
far happened to be captured with the phone in its default orientation, so
this would never have surfaced until now.

## 1a. That hypothesis was tested against real data and did not hold

Before implementing, the fix was verified directly: `sharp(...).rotate()`
against the real photo correctly swaps its dimensions (`4032×3024` →
`3024×4032`) and strips the tag, confirming the rotation step itself works.
But running the *corrected* buffer through the actual OCR pipeline still
produced the same class of scrambled title block:

```
blic of the Philippines RCES
ie F ENVIRONMENT AND NATURAL RESOU
DEPARTMENT © T BUREAU — REGIONAL OFFICE NO. |
```

Confidence was, if anything, slightly lower than the uncorrected reading
(65 vs. 70). Rotation was not the cause of this specific garbling. A
follow-up hypothesis — glare concentrated at the title block, visible in
the photo — was also checked directly: a brightness grid across the
rotated image shows a general left-to-right lighting gradient spanning the
*entire* page (title-row values 148-183, mid-body values as low as 98),
not an isolated bright spot at the title. Neither hypothesis explains why
specifically the dense multi-line title scrambles while the body text
reads cleanly, and no third hypothesis was pursued — see the Common
Rationalizations table in `superpowers:systematic-debugging`: guessing a
third cause after two failed would be exactly the pattern that skill warns
against.

**Decision:** implement the EXIF-rotation fix anyway, on its own merits —
processing an image in its intended orientation is correct regardless of
whether it explains this particular photo's garbling — and accept that
photo's title-block scrambling as an unexplained, undiagnosed capture-
quality issue, not a bug this design closes. See §5.

## 2. What this adds

`src/ocr.js`'s `recognize()` gets one new step, before the image ever
reaches Tesseract: run the incoming bytes through `sharp`'s built-in
EXIF-aware auto-rotate.

```js
import sharp from 'sharp';
// ...
const rotated = await sharp(imageBytes).rotate().toBuffer();
const { data } = await w.recognize(rotated, {}, { blocks: true });
```

`sharp(...).rotate()` called with no arguments reads the image's own EXIF
orientation tag, physically rotates the pixel data to match, and strips the
tag from its output (so nothing downstream can double-rotate it by also
respecting a now-stale tag). An image with no orientation tag, or tag `1`
(normal), passes through unchanged.

**New dependency: `sharp`.** A native-binary image library with
well-maintained prebuilt binaries for Windows/Mac/Linux via npm. Considered
against a smaller EXIF-rotation-only package and against vendoring
Tesseract's own OSD model (`osd.traineddata`) — see the brainstorming
conversation for the comparison; `sharp`'s auto-rotate is a single,
well-tested call rather than a second heuristic layered on top of the one
that produced this bug, or a narrower, less battle-tested package for
something this fiddly.

## 3. Coordinate space — verified, not assumed

`locateFindings()` (`src/ocrRegions.js`) draws a finding's box using
Tesseract's own word bounding boxes, and the frontend (`drawPhotoWithBoxes`,
`public/app.js`) draws those boxes on top of a canvas rendering of the
*original*, unrotated file — browsers apply the same EXIF rotation
internally when decoding `<img>`/canvas, landing at the same final
dimensions and orientation `sharp`'s corrected output does. Because
`recognize()` now feeds Tesseract the already-corrected buffer, its
bounding boxes are reported in that same final, upright coordinate space —
the one the browser's own rendering already uses. No coordinate transform
is needed anywhere else in the pipeline.

This claim is checked directly against the real rotated photo
(`test/fixtures/pages/2-genuine-rotated.jpg`) as part of implementation,
not assumed from the reasoning alone — the same discipline this feature
has followed for every other claim about real capture behavior.

## 4. Testing

- **The real rotated photo** (`test/fixtures/pages/2-genuine-rotated.jpg`,
  genuine, page 2, EXIF orientation 6) added to the calibration fixture set.
  `scripts/ocr-calibrate.mjs` re-run against all fixtures, confirming only
  what's actually true per §1a: no *material* false positive on this page
  (criterion 1 still holds), and the rotation step runs without error on a
  real EXIF-tagged capture. Not confirming a drop in tolerant-finding count
  — §1a already found real testing does not support that expectation.
- **`recognize()`'s rotation step**, isolated: construct or reuse a small
  JPEG with a non-1 EXIF orientation tag, confirm the bytes `sharp` returns
  decode to the expected (rotated) pixel dimensions, orientation-tag-free.
- **An unrotated photo (EXIF orientation 1, or no tag at all) is
  unaffected** — confirm `sharp(...).rotate().toBuffer()` is a no-op change
  to pixel content for a normally-oriented image, so nothing regresses for
  every capture that was already fine.

## 5. Honest limits

- **Does not fix the garbling that motivated it.** Per §1a, the specific
  title-block scrambling on `2-genuine-rotated.jpg` remains unexplained
  after two tested hypotheses (rotation, glare). This design is a
  correctness improvement (OCR sees images in their intended orientation)
  that happens to have been discovered via that photo, not a fix for it.
  If the same scrambling pattern shows up on a future, differently-shot
  photo, that is new evidence worth a fresh investigation — it should not
  be assumed solved because this design shipped.
- **Only covers what EXIF orientation actually records** — the eight
  standard values (normal, three rotations, and their mirrored variants).
  A camera or app that fails to write the tag at all (rare, but possible on
  some Android devices or after certain image-editing tools strip
  metadata) leaves the image exactly as unprotected as it was before this
  design. This is a real, known limit, not solved here.
- **`sharp` is a native-binary dependency**, unlike everything else in this
  project's dependency list. If its prebuilt binary is ever unavailable for
  a deployment target, installation fails outright rather than degrading
  gracefully. Accepted given how well-established its cross-platform
  support is; revisit only if that assumption is ever contradicted in
  practice.

## 6. Out of scope

- **Detecting or correcting rotation that has no EXIF tag at all** (a
  genuinely free-hand, untagged photo). Named as a limit in §5.
- **Any change to `locateFindings()` or `drawPhotoWithBoxes`.** §3's whole
  point is that neither needs to change; if real-photo verification
  contradicts that, it gets fixed as its own investigation, not folded in
  here silently.
- **Deskewing a modestly tilted (not 90°-rotated) photo.** A separate,
  much harder problem (continuous angle, not a discrete EXIF tag) — out of
  scope for this design, which only addresses the discrete case a camera's
  own metadata already records.
