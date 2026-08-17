# Page Image OCR — Confidence Boxes on the Photo — Design

**Date:** 2026-08-17
**Status:** Approved design, pre-implementation
**Extends:** `2026-08-13-page-image-ocr-design.md`

## 1. Problem

The photo-comparison feature reports findings as a text list: "record X ·
photo Y". Locating the corresponding spot on the actual photo — the thing a
reader needs to do to judge whether it's a real discrepancy or a bad read —
means eyeballing the whole page by hand. Nothing on screen points at it.

Separately, the report currently discards information Tesseract already
computes for free: a confidence score and a bounding box **per recognized
word**. `src/ocr.js` reads only the page-wide mean and the flattened text;
the per-word detail is thrown away.

This design uses that discarded detail to draw a box on the photo at each
finding's location, so a reader can jump straight to the spot instead of
hunting for it — with the box styled to show whether the underlying OCR read
was itself confident.

## 2. What a box means, and what it does not

**A box is a location pointer, not a verdict.** It marks where on the photo
a finding's `found` value was read from. Every finding that has a matched
photo location gets one — material and tolerant alike. Box *color* reflects
the underlying word confidence (amber outline when the read was shaky), but
the box's *presence* is unconditional: it never signals "this is more/less
likely to be real" by existing or not existing.

This keeps the box entirely inside the existing "evidence, not proof"
framing (spec `2026-08-13`, §2): it adds no new judgment to the report. The
findings list — the thing seven rounds of review made trustworthy — is
unchanged in what it reports and why. The box is purely a navigation aid
layered on top.

**Consequence, stated plainly because it governs the architecture below:**
confidence must never be allowed to change whether something is a finding,
or its severity, or its reason. It only changes how a box is drawn once a
finding already exists.

## 3. Where it sits

```
recognize()                    compare()                    locateFindings()
[src/ocr.js]                   [src/pageCompare.js]          [new, pure]
     │                              │                              │
     ├─ text ──────────────────────►│                              │
     │                              ├─ report { findings, ... } ───►│
     └─ words: [{text,              │                               │
        confidence, bbox}] ─────────┼──────────────────────────────►│
                                     │                               │
                                     │              findings, each optionally
                                     │              carrying .region ◄┘
                                     ▼
                          verifyPageImage() — calls compare(), then
                          locateFindings(), returns the merged report
                                     │
                                     ▼
                              frontend — canvas over the photo,
                              one box per finding.region
```

`compare()` is **not modified**. It stays a pure function of two strings,
exactly as reviewed. `locateFindings()` is a second, independent pure
function that takes the report `compare()` already produced plus the raw
word list, and enriches findings with a `region` — nothing it does can
change a finding's existence, severity, or reason, because it runs *after*
those are already decided and only ever adds a `region` key.

## 4. `recognize()`'s new return shape

```js
// src/ocr.js
{
  text,            // unchanged
  meanConfidence,  // unchanged — still gates image_unreadable, untouched
  wordCount,       // unchanged
  words: [
    { text: 'Section', confidence: 0.91, bbox: { x0, y0, x1, y1 } },
    { text: '12',       confidence: 0.34, bbox: { x0, y0, x1, y1 } },
    // ...
  ],
}
```

Sourced directly from Tesseract's own `data.words[]` (confirmed present in
`tesseract.js`'s type definitions: `text`, `confidence` 0–100, `bbox` with
`x0,y0,x1,y1`). `confidence` is rescaled to 0–1 on the way out, matching
`meanConfidence`'s existing convention. `bbox` is passed through unchanged —
it's already in the original photo's pixel space, which is exactly the
space the frontend needs it in (§7).

This is strictly additive to the existing interface. Nothing that reads
`text`/`meanConfidence`/`wordCount` changes.

## 5. `locateFindings()`

```js
// new module, pure — no I/O, no OCR engine, no DOM
locateFindings(findings, words) => findings, each optionally carrying:
  region: { x0, y0, x1, y1, confidence }   // present only when located
```

For each finding with a non-null `found` value, search `words` for the
contiguous run whose concatenated text matches `found` (case-insensitive,
whitespace-collapsed — the same normalization posture `pageCompare.js`
already uses, but applied here only to *locate* a span, never to decide
whether it's a match). On a hit: union the run's bboxes into one box, and
take the **minimum** confidence across the run — one badly-read word in an
otherwise-clean run is exactly what a reader most needs the box to flag.

**Findings with `found: null` (reason `missing`) get no region.** There is
nothing on the photo to point at — the value wasn't read at all, so there's
no OCR word to circle. They still appear in the list exactly as today, just
without a box.

**Fails safe by construction.** If the search finds no matching run — the
value spans a line break Tesseract split oddly, OCR fragmented it into
unexpected pieces, whatever — the finding simply gets no `region`. This is
not an error path; it degrades to today's behavior (list-only, no box) for
that one finding. Nothing about the finding's content, severity, or
presence in the list is contingent on the search succeeding.

**Ambiguity — a value appearing more than once on the photo.** Take the
first unclaimed match in document order and consume it (same pattern
`pageCompare.js`'s own token pairing already uses for exactly this reason:
a naive unconsumed match lets two different findings claim the same word
run). Getting the *wrong* one of two identical occurrences costs nothing
worse than a box in a slightly wrong-but-plausible spot — it cannot invent
or suppress a finding.

## 6. Frontend

The uploaded photo is already in the browser as a `File` before it's
POSTed — nothing new needs to reach the server to get it back. On response:

1. Draw the photo to a canvas.
2. For each finding with a `region`, draw a rectangle scaled from the
   photo's natural pixel dimensions to the canvas's displayed size.
3. Box style: severity's existing color for the outline (material =
   `var(--warn)`, tolerant = `var(--slate)` — **never `var(--ok)`, same
   rule as the rest of this feature**), with the fill or outline weight
   reflecting `region.confidence` (e.g. a lighter/dashed treatment above
   some confidence floor, solid amber below it — exact styling is an
   implementation detail, not a spec-level decision).
4. Clicking a finding in the existing list scrolls/highlights its box, if
   it has one — a cheap way to tie the two views together without
   duplicating the list itself.

The findings list is unchanged in content. The photo view is additive.

## 7. Coordinate scaling

Tesseract's `bbox` values are in the original uploaded image's pixel
dimensions. The canvas may display the photo at a different size (a phone
photo is typically thousands of pixels wide; the screen is not). Scale
factor is `displayedSize / naturalSize`, applied to all four bbox
coordinates before drawing. Standard image-annotation arithmetic — no new
concept, just needs to be done once, correctly, on the client.

## 8. Error handling

- `locateFindings()` never throws on a failed search — see §5's fail-safe
  behavior. A malformed or empty `words` array degrades every finding to
  "no region," not an error.
- If the photo itself fails to load into the canvas client-side (corrupt
  file, browser codec issue), the box overlay simply doesn't render — the
  findings list, which came from the server response already, is
  unaffected and still displays.
- None of this participates in the existing `image_unreadable` /
  `no_record_copy` / `page_differs` / `ocr_engine_error` status gates. It
  only ever runs on a `compared` result that already has findings.

## 9. Testing

`locateFindings()` is tested exactly like `pageCompare.js`'s pure
functions: fixed word-list fixtures, fixed findings, `node:test`, no OCR
engine, no DOM. Required cases:

- a finding's `found` value matches a single word exactly → region present,
  confidence equals that word's.
- a finding's `found` value spans multiple words → region is the union of
  their bboxes, confidence is the **minimum** across the run.
- a finding with `found: null` → no region, no crash.
- a `found` value with no matching run in `words` → no region, no crash
  (the fail-safe path — this is the one to prove with a fabricated case,
  same discipline as every other fail-safe path on this feature).
- two findings whose `found` values are identical text appearing twice in
  `words` → each gets a **different** region (the consume-on-match rule),
  not the same one twice.
- case and whitespace variation between `found` and the word-run text still
  locates correctly (mirrors real OCR casing/spacing noise).

No test for this feature loads an OCR engine or touches a browser — same
discipline as everything else in this codebase's OCR test suite.

## 10. Honest limits

- **The record side has no location concept.** `authText` comes from exact
  PDF text extraction, which — as already documented as an open risk on
  the base feature — is flattened to one line with no positional data.
  Boxes only ever appear on the **photo**, never on a "where in the
  record" sense, because the record side genuinely has no equivalent of a
  bounding box to offer. This isn't a gap introduced here; it's the same
  known limitation this feature already lives with.
- **A missed OCR-side match still shows no box**, even when the finding
  itself is real and material (`reason: missing`). The reader still has to
  find that one by eye. Only findings where OCR *did* read something get a
  location.
- **Word-fragmentation across a line/column break** can defeat the
  contiguous-run search even when the value is genuinely present on the
  photo — Tesseract's own word segmentation, not something this feature
  controls. Fails safe (§5), so the cost is a missing box, never a wrong
  finding.
- **The confidence-styling threshold is a new, separate, lower-stakes
  provisional constant** — same category as `THRESHOLDS`/`MIN_CONFIDENCE`
  on the base feature, and it needs the same real-photograph calibration
  before it means anything precise. Unlike those, getting this one wrong
  costs a box drawn slightly wrong (too eager or too sparse amber
  styling) — it cannot hide or fabricate a finding, because it never
  touches whether a finding exists.

## 11. Out of scope

- **Changing what counts as a finding, or its severity, based on
  confidence.** Explicitly rejected in favor of this design — see §2.
- **Boxes on every low-confidence word regardless of whether it produced a
  finding.** Considered and rejected: on a real, uncalibrated phone photo,
  confidence is noisy across far more words than are ever relevant, and
  boxing all of them would bury the meaningful ones in visual clutter.
  Boxes are scoped to findings only.
- **Persisting the photo or its boxes.** The uploaded image is still never
  written to disk or stored in the DB, per the base feature's existing
  rule. The canvas rendering is client-side and transient, same as the
  photo itself already was before this feature.
- **Record-side location markers**, per the honest-limits note above —
  would require carrying positional data out of `pdfTools.js`, which
  flattens it today; a bigger, separate change with its own risk profile
  (the base feature's design already flags that file's flattening as an
  accepted, deliberately-deferred risk, precisely because "fixing" it
  could affect already-sealed documents' digests).
