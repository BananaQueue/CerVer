# Page Image OCR — Dropping Low-Confidence Tolerant Findings — Design

**Date:** 2026-08-25
**Status:** Approved design, pre-implementation
**Extends:** `2026-08-13-page-image-ocr-design.md`, `2026-08-17-ocr-confidence-boxes-design.md`, `2026-08-25-record-line-preserving-extraction-design.md`

## 1. Problem

Live-testing surfaced a report with 27 "differences put down to the camera" —
every one of them a tolerant `name`-class finding, none material, all
individually itemized in the UI. One specific mechanism behind some of them
(a title split across a real printed line-wrap) was found and fixed the same
day. But the underlying pattern is broader than that one mechanism: any
`name`-class value that OCR reads badly enough to look genuinely different,
without being *garbled in a way any specific rule anticipates*, still
produces an itemized, individually-explained "difference" — even though
`ocrRegions.js`'s `locateFindings()` already computes exactly the signal that
would say so: the minimum OCR word confidence over the matched span
(`region.confidence`). That number exists today purely to decide a box's
*styling* — nothing decides whether a finding built on a low-confidence
reading is even worth listing at all.

A pre-existing, unrelated bug was found and fixed first (see the
`fix(ocr): stop double-counting itemized tolerant findings in the headline`
commit): the frontend's "N differences put down to the camera" headline was
adding the itemized tolerant count on top of `rep.suppressed`, which already
included it. That fix is a precondition for this design — the accounting
described in §3 below assumes it is already in place.

## 2. What this adds, and what it doesn't touch

A new module, `src/ocrNoiseFilter.js`, with one function:

```js
dropLowConfidenceTolerant(findings, minConfidence) => findings
```

It may remove a `severity: 'tolerant'` finding from the array when its
`region.confidence` is below `minConfidence`. That is the entire contract —
stated as plainly and narrowly as `ocrRegions.js`'s own header comment
states its:

- It never touches a `material` finding, regardless of confidence. The
  governing digit rule (`2026-08-13-page-image-ocr-design.md` §5.4) already
  established that confidence cannot distinguish a misread from a genuine
  edit — this module never gets the chance to blur that, because it is
  never given the option to act on anything but the class already proven
  safe to be lenient with.
- It never changes a finding it keeps — no field is added, removed, or
  modified on a surviving finding.
- It never touches a tolerant finding with no `region` at all (§5).

`compare()` (`src/pageCompare.js`) is not modified in any way — no new
parameter, no behavior change, every one of its 71 existing tests keeps
passing unmodified. `locateFindings()` (`src/ocrRegions.js`) is not modified
either; its own stated contract ("can only ADD a region... can never create,
remove, or change" a finding) stays true of that function specifically —
this is a new, separate function with its own, different, explicitly wider
contract, the same way `ocrFooter.js` and the footer-position design chose a
new mechanism over stretching an existing one.

## 3. Where it sits, and the `suppressed` count

```
recognize()      stripOcrFooter()     compare()      locateFindings()      dropLowConfidenceTolerant()
[src/ocr.js]      [src/ocrFooter.js]   [pageCompare.js] [src/ocrRegions.js]   [src/ocrNoiseFilter.js, NEW]
                                       UNCHANGED         UNCHANGED                  │
     │                 │                    │                 │                    │
     ├─ text ─────────►│                    │                 │                    │
     │                 ├─ cleanedText ─────►│                 │                    │
     │                 │                    ├─ report ───────►│                    │
     │                 │                    │  (findings,     ├─ located ─────────►│
     │                 │                    │   suppressed)   │  (+region on some)  │
     │                 │                    │                 │                    ├─ final findings
```

`dropLowConfidenceTolerant` is the last step in `verifyPageImage.js`, after
`locateFindings`. It does not touch `report.suppressed` at all. Given the
double-count fix in §1, `suppressed` already equals (itemized tolerant
findings) + (unitemized word-noise fudge). Removing a low-confidence
tolerant finding from the array, without adjusting `suppressed`, simply
moves that one item from "itemized in the list" into the same bucket the
word-noise fudge already lives in: differences the report is still honest
about having found, just no longer singled out as its own explained line
when there's nothing specific worth saying about it. No new field, no
adjustment, no double-counting.

## 4. The threshold: measured, not guessed

Per this project's established practice (`MIN_CONFIDENCE`, `THRESHOLDS.samePageMin`
— both measured from real photos, never guessed), `scripts/ocr-calibrate.mjs`
gets a small addition: for every fixture, run `locateFindings` on its
tolerant findings and report the resulting `region.confidence` values (or
`none` when a finding has no region at all). This is read once, by hand,
against the real committed photos in `test/fixtures/pages/` to pick a value
— not derived from a formula, the same way every other threshold in this
feature was set.

## 5. Honest limits

- **A tolerant finding shown as "photo: nothing"** — a record value with no
  matching span found anywhere in the photo's OCR text at all (e.g. the
  `BUREAU` / `REGIONAL OFFICE NO` entries from the live-tested report this
  design is responding to) — has no `region`, because `locateFindings` only
  attaches one when it can find a matching run of words. There is no
  confidence number to check, so this mechanism cannot touch that case. It
  only helps the case where a matched-but-garbled span produced a
  low-confidence "difference" — a real, separate class of noise from "no
  match was found at all," which would need its own, different mechanism if
  it turns out to matter.
- **This does not eliminate the need for `isWrapPrefix` or any other
  structural tolerance rule.** A low-confidence garbled reading and a
  clean-but-differently-wrapped reading are different failure shapes; this
  catches the first, not the second.

## 6. Testing

Pure function, `node:test`, matching `test/ocrRegions.test.js`'s own style
(synthetic findings, no OCR engine, no photo) — this function operates on
already-located findings, so its tests don't need a `words` array at all,
only findings with a `region.confidence` already set:

- A tolerant finding below the threshold is removed.
- A tolerant finding at or above the threshold is kept, unchanged (`assert.deepEqual`
  against the original object, to also catch any accidental mutation).
- A material finding below the threshold is kept regardless — this
  mechanism must never touch severity `'material'`, at any confidence.
- A tolerant finding with no `region` (the "photo: nothing" case) is kept —
  §5's stated limit, exercised as a passing test, not left implicit.
- An empty `findings` array returns empty, no crash.

Then, integration: full suite, plus a re-run of `scripts/ocr-calibrate.mjs`
against every real committed photo, confirming the chosen threshold removes
the low-confidence noise it's meant to without touching any of the 10
genuine pages' zero-material-finding baseline or the known alteration still
being caught.

## 7. Out of scope

- **Any change to `compare()`'s signature or behavior.** Considered in §1 as
  "Approach B" and rejected — a post-processing step already has every piece
  of data it needs.
- **Any change to `locateFindings()`'s contract.** It keeps meaning exactly
  what its own header comment says.
- **Suppressing a `material` finding by confidence, ever.** Out of scope in
  the strongest sense this project has: the governing digit rule exists
  specifically because confidence cannot resolve "misread vs. altered," and
  this design never lets that question come up.
- **Addressing the "found: null" / no-region case.** Named as a limit in
  §5, not solved here. If it turns out to matter, it gets its own design.
