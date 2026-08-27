# Page Image OCR — Comparing a Photographed Page Against the Record — Design

**Date:** 2026-08-13
**Status:** Implemented, calibrated against real photographs, and shipped on by default (2026-08-25) — see §9.2 for the final calibration record.
**Extends:** `2026-07-23-per-page-sealing-design.md`

## 1. Problem

A seal read off paper proves the page belongs to the document, sits at position
*k* of *n*, and was issued by EMB. It cannot prove **the words printed on that
paper**, because paper cannot be hashed — the digest is computed over the PDF's
text, and a photograph is not that text.

So the one attack the seal does not catch is **retyping the body of a genuinely
sealed page**: keep the real footer, change the amount. Today the remedy is a
human opening the authoritative page beside the sheet and reading both. That
works and stays available; it is also slow, and the differences that matter are
exactly the ones an eye skips — a digit, a date, a duration.

This design adds an optional second input: attach a photo of the page, and have
the server say which parts of it disagree with the record.

## 2. What this does and does not prove

**Stated first because it governs every UI decision below.**

This is a **heuristic aid, not a proof**. OCR is lossy and its output is
non-deterministic across captures of the same sheet. A comparison result must
never be presented with the authority of a seal verification.

| | Basis | Strength |
|---|---|---|
| Seal verification | HMAC over content, server-held secret | Proof |
| Full check on the PDF | Exact re-hash | Proof |
| **Photo comparison (this)** | OCR + text heuristics | **Evidence, needs a human** |

Consequences that are binding on implementation:

- A clean comparison is reported as **"nothing found"**, never "verified",
  "authentic", or a green stamp. Green is reserved for the seal.
- A comparison finding is a **prompt to look**, worded to send the reader to the
  authoritative page, which stays one tap away.
- Comparison never gates or overrides the seal result. A page whose seal is
  authentic stays authentic if the photo comparison is noisy or fails outright.

## 3. Where it sits

The attach appears on an already-verified page result, so document and page
number are known before any image is handled. It is not a separate entry path
and does not identify pages.

```
scan seal ──► page_verified (R1-2026-010734, p3/7)
                    │
                    └─► [attach a photo of this page]
                              │
                              ├─ ocr.js          image  -> text
                              ├─ pdfTools        record -> authoritative page text
                              └─ pageCompare.js  (both) -> ranked report
```

Authoritative text is already reachable: `pages.sealed_pdf_path` →
`extractPageTexts()` → index `k-1` → `stripFooter()`. The same functions the
sealer and `docVerifier` use, so the comparison cannot drift from what was
sealed. Nothing is added to the schema.

## 4. Modules

Three, split along the line between what is deterministic and what is not.

| Module | Signature | Depends on |
|---|---|---|
| `src/ocr.js` | `recognize(imageBytes) -> { text, meanConfidence, wordCount }` | OCR engine |
| `src/pageCompare.js` | `compare(ocrText, authoritativeText) -> report` | nothing |
| `src/verifyPageImage.js` | `(db, imageBytes, {iisNo, k, path}) -> result` | both, plus `pdfTools` |

`pageCompare` is a pure function with no I/O and no engine. Every judgment in
this design lives there, which is what makes it testable without photographing
anything. `ocr.js` holds all the flakiness and has one job.

This mirrors the existing split where `sealCode.js` is pure and `decode.js`
handles pixels.

## 5. The comparison

### 5.1 Why not a diff

OCR of a phone photo of a printed page produces character errors throughout. A
character-level or line-level diff of a **genuine** page reports dozens of
differences. Staff learn within a week that the list is noise and stop reading
it, at which point the feature is worse than absent — it launders a real finding
in among false ones.

So the output is not a diff. It is two questions answered separately.

### 5.2 Tier 1 — is this the same page at all?

Word-level alignment ratio between the two normalized word sequences:

```
similarity = 2 * |LCS(a, b)| / (|a| + |b|)
```

Symmetric in its arguments, and neither dropping words nor inventing them is
free — both pull the score below 1. (They are not weighted identically: an
invented word also grows the denominator, so an insertion costs slightly less
than a deletion. That asymmetry is inherent to the measure and is not worth
correcting for, since Tier 1 only has to separate "same page" from "not this
page".) One number.

Its purpose is to separate *this is page 3, photographed imperfectly* from
*this is not page 3*. A page substituted wholesale from another document — the
attack the seal already catches when the footer travels with it, but not when
the footer is reprinted — lands here.

Below the threshold, Tier 2 is not reported at all: token findings against the
wrong page are meaningless and would bury the real result.

**The threshold is not set in this document.** It is calibrated in §9 against
real photographs. Writing a number here before measuring is how the size ladder
went wrong.

### 5.3 Tier 2 — did the values survive?

The check that earns the feature. Extract **high-value tokens** from the
authoritative text and confirm each survives in the photo — and, in the other
direction, that the photo carries none the record does not.

Both directions are required. Substitution and insertion are both attacks; a
one-way check catches only half.

Token classes, in reporting order:

| Class | Pattern | Match rule |
|---|---|---|
| Money | `₱`/`PHP`/`P` + digit groups | strict |
| Date | numeric (`01/15/2026`, `2026-01-15`) and worded (`15 January 2026`) | strict |
| Duration | `<n> day(s)/month(s)/year(s)`, incl. `calendar day` | strict |
| Reference | `R1-YYYY-NNNNNN`, `No. 25-0123`, permit numbers | strict |
| Citation | `Section 12`, `Rule III`, `Article 5` | strict |

Roman numerals in citations are compared under a letter-confusion fold
(`I l 1 |` → `I`, `V v` → `V`) *before* the strict rule applies. `Rule III` read
as `Rule Ill` is the camera, and without the fold it would be a standing false
positive on every document that cites a rule — against criterion (1) in §9.2.
The digit rules in §5.4 are unaffected: they apply to digit tokens, and a Roman
numeral has none.
| Name | runs of 2+ ALL-CAPS words | tolerant |

**Numbers strict, words tolerant.** Amounts, dates and durations are short,
high-contrast, and are what gets altered. Names and headings are long, OCR
poorly, and a wrong character in one is far more often the camera than a forger.

### 5.4 Normalization, and what is never normalized away

Applied to both sides before comparison:

- collapse runs of whitespace; strip the footer line via `stripFooter()`
- unify quote and dash variants, `₱`/`P`/`PHP`, and thousands separators
- letter↔digit glyph confusions **normalized toward the digit** inside numeric
  tokens: `O o Q D → 0`, `l I | → 1`, `S → 5`, `B → 8`, `Z → 2`, `G → 6`
- word-level confusions in tolerant comparisons only: `rn↔m`, `cl↔d`, `vv↔w`

Never normalized, in any class:

- **digit count.** `50,000` vs `500,000` differ in length; length difference is
  always material.
- **digit↔digit substitution at a position.** `15` vs `45` is material.

The reasoning is that we cannot distinguish "OCR misread 1 as 4" from "someone
changed 1 to 4", and the cost of the two errors is not symmetric. A false
positive costs one person one minute of looking at the real page. A false
negative is a forged amount cleared by CerVer. So digit↔digit disagreement is
always reported, and the noise it generates is accepted.

Letter↔digit confusion is different and is forgiven: no forger substitutes `O`
for `0` — that is unambiguously the camera.

### 5.5 Report

```js
{
  status: 'compared' | 'page_differs' | 'image_unreadable' | 'no_record_copy',
  similarity: 0.94,                  // tier 1
  findings: [                        // material first, then tolerant
    { severity: 'material', class: 'money',    line: 14,
      expected: '₱50,000.00', found: '₱500,000.00', reason: 'digit-count' },
    { severity: 'material', class: 'duration', line: 22,
      expected: '15 days', found: '45 days', reason: 'digit-substitution' },
  ],
  suppressed: 37,                    // differences attributed to OCR noise
  ocr: { meanConfidence: 0.86, wordCount: 412 },
}
```

`line` is the 1-based line number **in the authoritative page text**, so that a
finding points somewhere on the sheet the reader is holding. For a token the
photo carries but the record does not, there is no such line and it is `null`.

`suppressed` is shown as a count and is expandable. It is present so that a
reader who suspects the filter is hiding something can look, rather than having
to trust it.

## 6. API and disclosure

```
POST /api/verify-page-image     multipart: image, doc, k   (bodyLimit 12 MB)
```

The 12 MB limit and the multipart handling follow `/api/frame` and
`/api/verify-document`, which already take large uploads on named routes only.

### No disclosure gate

**One report, the same for every caller.** An earlier draft of this design
withheld `expected` from non-staff callers, on the theory that a forger could
otherwise ask the server what the page should say. That is dropped, for two
reasons.

The `staff=1` flag was a query parameter set by a checkbox on the public page —
anyone could tick it. It never authenticated anyone. It is being removed from
`/api/verify-page`, `pageVerifier`, and the UI in the same period this design
was written, on exactly that ground.

And the threat it was meant to answer does not survive the routes as they stand.
`/api/page-image?doc=…&k=…` serves the **entire authoritative page** to any
caller, ungated, and `/api/pages/:iisNo` lists every page's printed footer. That
is deliberate — the cross-reference exists so a person holding paper can read
the real page. Withholding one `expected` string from a report while serving the
whole page one route over is not protection; it is the appearance of protection,
paid for in usefulness.

If page content should be restricted, that is real authentication across every
route that serves it, and it is out of scope here (§11). Half a gate on one
route is worse than none, because it invites the belief that the content is
guarded.

Each request logs to `verify_log` with outcome `page_image_<status>`, path, and
client hint, matching how `verifyPage` and `verifyDocument` already log. The
image itself is **not** retained.

## 7. Errors, reported as themselves

The failure mode to avoid is a bad photograph presenting like a bad page.

| Condition | Status | Told to the reader |
|---|---|---|
| `sealed_pdf_path` null | `no_record_copy` | No authoritative copy on file — the seal result stands |
| OCR yields too few words, or mean confidence below floor | `image_unreadable` | Photo could not be read — retake it flat, in better light |
| Tier 1 below threshold | `page_differs` | This does not look like page *k* — open the record page |
| Otherwise | `compared` | *n* things worth checking / nothing found |

`image_unreadable` is a **request for a better photo**, never a finding about the
document, and is styled as neither pass nor fail. OCR failing is the expected
outcome for a shadowed, angled, or half-cropped capture, and that must cost the
document nothing.

## 8. OCR engine

Node has no built-in OCR. `tesseract.js` (Apache-2.0, wasm) is the choice: it
installs from npm without an office-wide binary rollout, and it runs in the same
process as everything else.

**It must be pinned to local language data.** By default it fetches
`eng.traineddata` from a CDN on first use, which would make verification depend
on the internet and fail closed in exactly the offline setting this app is built
for. The file is committed to the repository and `langPath` points at it, in the
same spirit as the vendored `pdfjs` and `html5-qrcode`.

It goes in **`vendor/tesseract/`** at the repository root — *not* `public/vendor/`.
`public/` is statically served to every browser, and this data is read only by
the server; putting it there would ship a multi-megabyte file to every phone
that loads the scan page and never use it.

Use the `_fast` traineddata variant, which is a few megabytes rather than the
tens of megabytes of the full model, and is the accuracy tier tesseract.js
defaults to anyway. The committed file is 4,113,088 bytes, measured rather
than estimated.

English only. EMB documents are in English; adding Filipino language data is a
later decision with its own accuracy question, not a free flag.

OCR runs **server-side**. The comparison needs the authoritative text, which is
server-side; doing OCR in the browser would mean shipping the engine and its
data to every phone over the LAN and running a slow wasm pass on the weakest
device in the chain, then uploading the text anyway.

## 9. Testing

### 9.1 `pageCompare` — deterministic, no engine

Fixed input strings, standing in for OCR output. No image, no wasm, no
nondeterminism; these run in `npm test` with everything else.

- clean page, realistic OCR noise throughout → no material findings
- `₱50,000.00` → `₱500,000.00` → material, `digit-count`
- `15 days` → `45 days` → material, `digit-substitution`
- `₱50,000.00` → `₱5O,OOO.OO` → suppressed, not a finding
- an amount **added** that the record does not carry → material
- ALL-CAPS name with two character errors → tolerant, not material
- text of a different page entirely → `page_differs`, no token findings reported
- empty and whitespace-only OCR output → `image_unreadable`, no crash

### 9.2 OCR accuracy — real photographs only

**Rendered PDF pages are not admissible evidence here.** A render has perfect
contrast, no perspective, no shadow, no paper texture, and no printer dot gain.
This project has already spent three rounds acting on numbers that came from
synthetic samples — the size ladder measured a capture bug and reported it as a
property of ink. A comparison tuned against renders would report an accuracy it
does not have on paper.

So: photograph real printed sealed pages, check them into `test/fixtures/`, and
calibrate against those.

Shipping criteria, to be established from that set and recorded here once
measured:

1. **Zero material false positives** across the genuine-page set. This is the
   binding one. One false alarm per genuine page and staff stop reading the
   output.
2. The Tier 1 threshold, chosen to separate genuine pages from a
   different-page capture with margin on both sides.
3. The `image_unreadable` confidence floor, chosen so that deliberately poor
   captures — angled, shadowed, half-cropped — land there rather than in
   `page_differs`.
4. A photographed page with a **known** altered amount is caught.

Until (1) holds on real photographs, the feature is not shipped, regardless of
how the synthetic tests read.

**Measured 2026-08-24, first round**, iPhone camera, ordinary office
lighting, against `scripts/print-test-sealed.pdf` (`R1-2026-010734`). 5
photographs: 2 genuine, 1 deliberately altered (control number
`R1-2026-010734` → `R1-2026-010784`), 1 attempted-poor, 1 page of an
unrelated document (`R1-2025-025065`). This first round found a real,
material false positive (a garbled footer misread bleeding a second
reference reading into the body text) and left criterion 3 unmeasured —
see the history below for how each was resolved.

**Measured 2026-08-25, final round, all criteria hold.** 16 photographs: 10
genuine (across all 3 pages), 3 poor, 2 altered, 1 of an unrelated document.

1. **Holds.** 10 genuine pages, zero material findings on any of them —
   at the plan's full 5-genuine minimum and beyond. Getting here required
   fixing four real bugs the expanded photo set surfaced, each root-caused
   and fixed rather than threshold-tuned around: a garbled footer stamp
   leaking a second, misread reference reading into comparison (fixed by
   locating the footer by page position, not exact text shape); the
   record's line-break-free text merging two separate printed title lines
   into one (fixed, then later made structurally unnecessary once the
   record extraction started preserving real PDF line breaks); a title
   wrapping differently on the printed page than in the flattened record
   text (fixed via prefix tolerance, kept as a backstop even after the
   line-preserving extraction); and a digit-as-letter OCR misread in a
   control number (`R1` read as `Rt`) invisible to the strict `reference`
   pattern entirely, fixed by extending it the same glyph-tolerant
   extraction `money` and `citation` already had.
2. **Set: `samePageMin = 0.4`** (`src/pageCompare.js`). Genuine similarity
   floor `0.739`, other-page ceiling `0.000` — a wide gap, margin on both
   sides. Unchanged since the first round; the wider sample did not move it.
3. **Set: `MIN_CONFIDENCE = 0.65`** (`src/verifyPageImage.js`), from a real
   measured gap. Most `poor` attempts (angle, reduced framing) still read at
   `0.740`–`0.760` — above the lowest genuine reading — because the capture
   phone's Deep Fusion pipeline (on by default, no setting to disable it)
   corrects deliberately degraded photos back to something legible; that
   limitation is accepted, not solvable by confidence alone. Two captures
   using real motion blur / dim handheld shake did get past it, reading
   `0.470` and `0.550` — both clearly below the genuine floor (`0.720`)
   measured across all 10 genuine samples. `0.65` sits with margin on both
   sides of that real gap.
4. **Caught, cleanly.** Both altered photographs flag exactly the
   deliberate change (the control-number digit swap) with the correct
   before/after values and nothing else — the unrelated footer-misread
   finding that muddied this criterion in the first round is gone, fixed
   at its source rather than masked.

**Since criterion 1**, a further, separate improvement: a new
confidence-weighted filter (`src/ocrNoiseFilter.js`, 2026-08-25) drops a
tolerant (`name`-class, never material) finding from the itemized list when
the underlying photo text was read with too little confidence to be worth
explaining — `MIN_TOLERANT_CONFIDENCE = 0.4`, measured the same way, from a
real gap between genuine pages' near-zero-confidence noise and their
legitimately-read differences. This does not change any shipping criterion
above; it only reduces how much unexplained tolerant noise a genuine page's
report shows.

## 10. Honest limits

- **Not proof, and never rendered as proof.** §2 governs. The seal remains the
  only thing that proves anything about a page.
- **Bounded by print quality.** A faint, skewed, or heavily stamped page will
  land in `image_unreadable` and give no answer. Correct behaviour, but it means
  a determined forger can defeat the check by supplying a bad photograph — which
  is why a failed comparison never affects the seal verdict, and why the human
  comparison stays.
- **Layout is not compared.** Only text. A page whose words are identical but
  whose signature block or letterhead has moved reads as clean here.
- **Handwriting is not read.** Filled-in blanks, marginal notes, and wet-ink
  annotations are invisible to this check.
- **Tolerant-class findings are weak.** A name mismatch may be OCR and usually
  is. It is reported below the material findings and worded as such.
- **The committed language data** is a real repository cost, paid so that
  verification does not depend on the internet.
- **Thresholds are measured, not provisional (2026-08-25).** §9.2's
  criteria are satisfied against real photographs; every constant this
  section once described as an uncalibrated placeholder now carries the
  real measurement it came from, in the constant's own comment.

## 11. Out of scope

- **Identifying the page from the photo** (OCR'ing the footer line as a fallback
  input when the pixelated mark will not decode). A reasonable feature, separate
  concern, and it would double the accuracy surface to tune. The mark's
  stroke-tolerant decoder is the current answer to hard reads.
- **Layout / visual diff** of the photograph against a render of the record page.
- **Filipino language data.**
- **Authentication for page-content routes.** `/api/page-image` and
  `/api/pages/:iisNo` are ungated by design, and this feature adds no new
  exposure — it reports on a page the same caller can already fetch in full. If
  that changes, it changes for all of them at once, not here.
- **Retaining uploaded images** for later review or as an audit trail. Nothing
  in the current design keeps them, and keeping document photographs is a
  records-retention decision, not an implementation one.
- **Client-side OCR.** Revisit only if server load becomes a real constraint.
