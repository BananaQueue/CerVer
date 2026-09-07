# Page Image OCR — List-Item Comparison — Design

**Date:** 2026-08-27
**Status:** Implemented and verified against real photos (2026-08-27). Both criteria hold as designed: `2-altered.jpg` now catches "Darwin Karl Pua" as a material `added` finding, and every genuine photo — including one that badly under-recognizes the list — reports zero material `listItem` findings. The original fixture set (`test/fixtures/pages/`, zero bulleted lines) is byte-for-byte unchanged, including the one pre-existing, already-accepted dropped-trailing-letter exception on `1-genuine.jpg`.
**Extends:** `2026-08-13-page-image-ocr-design.md`, `2026-08-25-labeled-field-comparison-design.md`

## 1. Problem

A real altered photo (`test/fixtures/pages-special-order/2-altered.jpg`) has a
name — "Darwin Karl Pua" — added as an extra bullet in a
`RESOURCE PERSONS/GUESTS:` list. Calibration reports zero material findings
for it: `CAUGHT NOTHING`.

The cause isn't suppression — it's that the entry is never tokenized at all.
Every name in this list is mixed-case ("Ms. Fernie D. Sitsit", "Atty. Ivy
Joyce De Pedro", "Darwin Karl Pua"), and the existing `name` class only
matches ALL-CAPS runs (`2026-08-13-page-image-ocr-design.md` §5.4, by
design — ordinary prose names OCR poorly and a wrong character is more often
the camera than a forger). The whole list is invisible to `compare()`, not
merely tolerated.

Widening `name` to accept mixed case would not, by itself, fix this: `name`
is a tolerant class, and since the tolerant-findings list was deliberately
removed from the report (this session, `renderOcrReport()`), a tolerant
finding is never shown to a reader at all. An added or removed list entry
needs to be capable of becoming a **material** finding — the thing that
drives the "this document appears to have been altered" banner — which
requires a new class with its own severity rule, not a wider pattern on the
existing tolerant one.

## 2. What the real data says

Real photos of this document's list page were checked directly (not
rendered — the same discipline as every other class in this codebase, per
spec §9.2):

- The bullet marker is a plain hyphen (`- `) and reads consistently across
  every real photo checked, genuine and altered alike (`2-genuine.jpg`,
  `2-genuine-b.jpg`, `2-altered.jpg`) — 4 independent captures, zero bullet
  misreads.
- The existing `name` pattern already partially claims spans **inside**
  these bulleted lines today: `"DENR R1 Regional Executive Director"` yields
  a stray `name` token `"DENR R1"` (the ALL-CAPS run), leaving the rest of
  the line masked. Any new extraction that runs after `name` would see a
  NUL-contaminated remainder on that specific line and — following this
  codebase's established fail-safe posture (`extractFieldTokens`'s own
  comment: "a shape this can't cleanly use is invisible to it, not an
  error") — silently drop that one entry from comparison. That's a
  correctness gap worth avoiding rather than accepting, since it's cheap to
  avoid (see §3).
- A genuine, unaltered photo (`2-genuine-b.jpg`, then a second one checked
  live during this design) can lose the *majority* of the list to OCR under
  ordinary capture conditions — one genuine capture recognized only 5 of 14
  bullet lines, another produced heavily garbled text across the entire
  list region at `meanConfidence 0.57`, despite being visually sharp,
  well-lit, and fully legible to a human reader. This was checked directly:
  per-word confidence mapped by vertical position in the frame shows the
  degradation is patchy (some bands read at 0.7+, others crater to
  0.18–0.26), not a uniform focus/lighting problem, and switching Tesseract's
  page-segmentation mode neither fixed it nor even failed the same way twice
  (`SINGLE_COLUMN` scored *higher* confidence while reading *less* of the
  list). This is the same class of engine-level page-segmentation fragility
  already documented and left unsolved elsewhere in this project (the
  QR-column-confusion gap, `2026-08-27-exif-rotation-correction-design.md`
  §1a/§1b) — not something this design can fix, and not something a photo's
  overall confidence score reveals reliably (`meanConfidence` and per-region
  confidence both looked plausible on captures that dropped most of the
  list).

That last point drives §4's severity split: a missing entry is not a
reliable signal of alteration on this document, because ordinary genuine
photos already demonstrate the OCR can drop most of a list's lines outright.
An added entry is a different, much stronger signal — the record is always
clean PDF text, so any list-shaped photo token with no record counterpart at
all cannot be explained by the record being wrong.

## 3. Extraction: whole-line, and first

A new `listItem` class matches a plain hyphen bullet line:

```js
const LIST_ITEM_LINE = /^\s*-\s+(.+?)\s*$/;
```

Unlike every other class, `listItem` extraction runs **before** money, date,
duration, reference, citation, and name — claiming the entire captured
line's span immediately, rather than picking through whatever's left after
finer-grained classes have already run. This is a deliberate, narrow
exception to `extractTokens`'s usual order (documented inline at the call
site): a list entry is compared as one atomic unit ("is this whole entry
present"), not decomposed into sub-values the way a `field` value is, so
there's nothing for a later, more specific class to usefully claim inside
it — and leaving it late would reintroduce exactly the NUL-contamination
gap §2 found on `"DENR R1 Regional Executive Director"`.

This ordering is verified not to disturb the original fixture set
(`test/fixtures/pages/`): its record and photo text contain zero lines
starting with a hyphen bullet, checked directly against the real committed
fixtures, so this new extraction step is a no-op there.

`keyFor` gets a `listItem` branch alongside `name` and `field`, reusing the
same fold path (`foldGlyphs` then `foldLetterNoise`) unchanged — the same
OCR noise (a misread letter, a digit-lookalike) that already gets forgiven
for a field value or a name should be forgiven here for the same reason: it
does not reflect on the record's authoritative text or the entry's
identity.

## 4. Severity: reuse the existing added-pass, one condition widened

`compare()` already has two passes:

1. **Record → photo**: does every record token survive? A `STRICT` class
   that fails to find its value reports material; anything else (today,
   only `name`) always reports tolerant, `near`-found or not.
2. **Photo → record** (the "added" detector): does the photo have a token
   the record never had? Gated today to `STRICT.has(o.cls)` only.

`listItem` is not added to `STRICT`. Instead:

- **Missing** (pass 1): no change needed. `listItem` isn't `STRICT`, so a
  record entry with no exact-key match on the photo side falls straight
  into the existing tolerant path that `name` already uses — reported, but
  never material, whether or not a `near` candidate happens to be found.
  This is what §2's data requires: an OCR-dropped entry must never surface
  as "altered."
- **Added** (pass 2): the one line that changes. Widen the gate from
  `STRICT.has(o.cls)` to `STRICT.has(o.cls) || o.cls === 'listItem'`. An
  extra photo-side entry with no record counterpart at all — Darwin Karl
  Pua's case — reports `severity: material, reason: 'added'`, using the
  exact mechanism every `STRICT` class already relies on for this, not a
  new one.

No other part of `compare()` changes. The nearest-unclaimed-token fallback
(`near`, used for tolerant reporting) needs no `listItem`-specific guard the
way `field` needed one for its `label`: list entries don't share a class the
way several different field labels do, so pairing by line distance alone is
adequate for the tolerant, informational report — severity itself no longer
depends on it.

## 5. Honest limits

- **A swapped identity at the same list position may go undetected.** If an
  existing entry's value is replaced outright (not appended, but
  substituted) and the replacement happens to land on the same line the
  original occupied, the nearest-by-line-distance fallback will most likely
  pair them and report it as an ordinary tolerant "text" difference, the
  same as an OCR misread of the same person's name. This design does not
  add a value-similarity check to tell "misread of the same entry" apart
  from "different entry entirely" — doing so needs an edit-distance or
  similar threshold with its own calibration, and no real photo evidence
  yet motivates it (every real alteration seen so far has been a pure
  append). Documented here rather than silently accepted, the same as the
  existing `field` class's dropped-trailing-letter exception
  (`2026-08-25-labeled-field-comparison-design.md` §6).
- **Only a plain hyphen bullet is recognized.** No numbered lists, no `•`
  or `*` markers. Every real photo checked uses a hyphen; widening to other
  markers without real evidence to require it would be exactly the kind of
  speculative tolerance this project avoids.
- **Does not fix list-line under-recognition.** §2's patchy-confidence,
  page-segmentation-fragility finding is real and unsolved; this design's
  answer to it is "don't let missing be material," not "read the list more
  reliably." A future fix to that (if one is ever found) is out of scope
  here.

## 6. Out of scope

- **Any change to `GLYPH_FOLD`, `foldLetterNoise`, or any existing class's
  extraction pattern.** This design adds one new class and widens one
  existing boolean condition (`STRICT.has(o.cls)` → `... || o.cls ===
  'listItem'`); nothing already reviewed changes behavior.
- **Value-similarity-based severity for the swapped-identity case.** See
  §5.
- **Recovering dropped list lines** (better OCR, alternate PSM, ensemble
  passes). Investigated and dropped this same day for unrelated reasons
  (see the multi-layer OCR memory record); unrelated to this design's scope,
  which only decides what to do once tokens exist, not how completely they
  can be extracted.

## 7. Testing

- **Extraction**: a hyphen-bulleted line is captured whole; a non-bulleted
  line is not; a bulleted line containing an ALL-CAPS run (e.g. "DENR R1
  Regional Executive Director") is captured as one `listItem` token, not
  partially claimed by `name` first — proves the ordering fix in §3.
- **`keyFor`**: a `listItem` value folds through the same path as `name`
  (glyph and letter-run noise forgiven).
- **`compare()`**: an added `listItem` with no record counterpart reports
  material, reason `added`; a record `listItem` missing from the photo
  reports tolerant, never material, `near`-found or not.
- **Real-photo calibration**, both fixture sets: `2-altered.jpg` now catches
  "Darwin Karl Pua" as a material finding; every genuine photo — including
  the two that badly under-recognize the list — still reports zero material
  `listItem` findings; the original fixture set (`test/fixtures/pages/`,
  zero bulleted lines) shows no behavior change at all.
