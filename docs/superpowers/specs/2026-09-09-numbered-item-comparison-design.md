# Page Image OCR — Numbered-Item Comparison — Design

**Date:** 2026-09-09
**Status:** Implemented and verified against real photos (2026-09-09).
Both real name substitutions are caught cleanly
(`1-altered-b.jpg`, `1-altered-d.jpg`); the misspelling on
`1-altered.jpg` is caught too. The removal-only alterations
(`1-altered.jpg`'s isolated item 9, `1-altered-c.jpg`'s dropped last
item) remain uncaught, exactly the accepted §5 limit. The bounding
rule itself needed two more rounds beyond what this design specified,
both found and fixed only after checking real photos, not reasoning
alone: a next-line marker now bounds an item when SOME marker on that
line has a strictly greater number (not merely "a marker is present,"
which false-positived on a genuine photo whose two columns have
different lengths, and not "checked on the first marker only" or "the
exact successor," each of which broke a different genuine case — see
`extractNumberedItemTokens`'s own comment for the full trail). Both
completely different real documents (`test/fixtures/pages/`'s wrapped
legal clauses, `test/fixtures/pages-special-order/`'s hyphen-bulleted
list) show zero behavior change.
**Extends:** `2026-08-13-page-image-ocr-design.md`, `2026-08-27-list-item-comparison-design.md`

## 1. Problem

A real document (`sealed/R1-2026-020780.pdf`, a "Special Order" authorizing
named personnel to attend an event) lists its personnel as a **numbered**
list (`1.`, `2.`, ... `18.`), not a hyphen-bulleted one. Four real altered
photos of it were checked directly, each carrying a genuine, deliberate
change within that list:

- `1-altered.jpg`: item 9 ("Darwin Karl B. Pua") removed, items 10-18
  renumbered down by one to close the gap.
- `1-altered-b.jpg`: item 5's name changed, "Lawrence" → "Laurence" — a
  different person, not an OCR-confusable pair (no letter-shape or
  letter-run resemblance the way `rn`/`m` or `B`/`8` do).
- `1-altered-c.jpg`: the list's last item (18, "Van Kenji R. Maglaque")
  dropped entirely, nothing renumbered since nothing followed it.
- `1-altered-d.jpg`: item 8's name changed, "Nichol" → "Nicole".

None of these are caught today. The `listItem` class (2026-08-27) only
recognizes a hyphen bullet; a digit-period marker is a different shape
entirely, and no class extracts numbered-list content at all. On an
authorization/identity document, a name substitution within that list is a
real falsification risk, not a cosmetic difference — see the design
rationale below for why this is scoped more assertively than `listItem`'s
missing-entry handling.

## 2. What the real data says

**A structural complication found immediately**: this document prints its
list in two side-by-side columns. Each OCR'd physical line therefore
contains *two* numbered items glued together
(`"Chester Lyndon S. Padilla 11. Mardave G. Nerveza"` is items 1 and 11 on
one line), not one. A naive "one marker per line" extraction corrupts
almost every value with the neighboring column's content. Fixed by
splitting a line on *every* digit-period marker found, not just the first
— each marker-to-next-marker span (or marker-to-end-of-line, when
unambiguous — see below) is one item.

**A second, harder complication, found by checking a completely different
real document**: `test/fixtures/pages/` (the original, already-shipped
fixture set, an unrelated permit document) *also* has a numbered list —
but of legal clauses, each wrapping across two or three physical lines
(`"3. Effluent shall conform to DENR Administrative Order 2016-08, Class
C" / "inland water standards. Quarterly sampling shall be undertaken by
a" / "DENR-recognized laboratory."`). A naive per-line-only extraction
would silently truncate each clause to its first physical line and very
plausibly report spurious mismatches against genuine, untouched photos of
that document — a live regression risk to an already-shipped feature, not
a hypothetical.

**The bounding rule that resolves this, verified against both documents**:
a marker's content is only trusted (extracted at all) when it is
unambiguously bounded — by another marker later on the *same* line, or by
the *next physical line* itself starting with a marker, or by being the
last line of the text. A marker whose content runs to end-of-line with no
such bound is presumed to be a wrapped continuation and is not extracted.
Checked directly:

- Against `test/fixtures/pages/2-genuine*.jpg` (the legal-clause document,
  3 real photos): **zero** items extracted, record or photo side. The
  wrapped-clause shape never satisfies the bounding rule anywhere.
- Against the numbered personnel list (record + all 5 real photos): 17 of
  the record's 18 items extract correctly (item 18 does not — see below);
  both real name substitutions are caught as material findings; the
  removal+renumber and the last-item-drop alterations are not — see §5.

**The cost of that safety, found twice over:**

1. The bounding rule also excludes some genuinely valid items when a
   removal happens to leave them structurally isolated. In
   `1-altered.jpg`, item 9's photo-side line ("`9. John Ruskhin P.
   Salayon`") lost its column neighbor (removed along with item 9's
   original content) and the line after it is ordinary paragraph prose,
   not another marker — so by the bounding rule this line is no longer
   trusted and item 9 reads as **missing** rather than the stronger
   **mismatch** signal (`record: "Darwin Karl B. Pua"` vs `photo: "John
   Ruskhin P. Salayon"`) it produced before the safety rule was added.
2. **More significantly**: this document's own record text has the exact
   same shape at the *end* of its list as the wrapped-clause document has
   *mid-clause* — item 18's line is followed by ordinary paragraph prose
   ("Services rendered by permanent personnel..."), not another marker,
   and it isn't literally the last line of the page. Nothing distinguishes
   that, locally, from a wrapped continuation. So item 18 is **not
   extracted from the record side at all** — not a photo-reading problem,
   a property of the record text itself. Any alteration to the record's
   own last numbered item, substitution or removal alike, is invisible
   under this design, not only the removal case. See §5.

## 3. Extraction

A new class, `numberedItem`, extracted by a dedicated function (not a
`TOKEN_PATTERNS` entry — the marker-to-marker/marker-to-next-line logic
needs a multi-line lookahead no single-line regex can express):

```js
const NUMBERED_MARKER = /\b(\d{1,2})\.\s+/g;
```

For each line, find every marker. For marker `i`:
- if another marker follows on the same line, the segment ends there;
- otherwise, if the *next physical line* starts with a marker
  (`^\d{1,2}\.\s+`), or this is the last line of the text, the segment
  runs to end-of-line and is trusted;
- otherwise the segment is **not extracted** — presumed a wrapped
  continuation.

Runs in the same position `listItem` does — before every other class,
claiming its own matched span (marker through the segment's end) whole, so
`name` cannot later partially claim an ALL-CAPS run inside a numbered
item's content the way it already does for hyphen-bulleted lines
(`2026-08-27-list-item-comparison-design.md` §2).

Each token carries `{ cls: 'numberedItem', number, value, line }` — unlike
every other class, `number` (not a fold of `value`) is the identity a
record entry and its photo counterpart are paired by. `keyFor` gets a
`numberedItem` branch alongside `name`/`field`/`listItem`, reusing the
identical fold path (`foldGlyphs` then `foldLetterNoise`) for comparing
*values* once paired — the same OCR noise already forgiven elsewhere
(a misread letter, a digit-lookalike) should be forgiven here too.

## 4. Matching and severity: a dedicated pass, not the generic key mechanism

Every other class is identified by its own folded *value* — `keyFor(cls,
value)` is what `compare()`'s generic record↔photo passes pair on.
`numberedItem` inverts this: identity is the *number*, and the value is
what gets compared once paired. That doesn't fit the generic mechanism
(which treats "same key" as "same content," not "same slot") without
distorting it, so `numberedItem` tokens are excluded from both generic
passes and handled by their own function, `compareNumberedItems`, whose
findings are concatenated into `compare()`'s result:

- **Record has number N, photo doesn't**: `severity: 'tolerant', reason:
  'missing'`. Deliberately not material — see §5's honest limit, and the
  same reasoning `listItem`'s missing-entry handling already established:
  real genuine photos demonstrably drop list content under ordinary
  capture conditions, and a bare absence can't be told apart from that.
- **Record has number N, photo has number N, values match** (after the
  `numberedItem` fold, or one is a genuine wrap-prefix of the other via
  the existing `isWrapPrefix` helper — the same OCR line-noise tolerance
  every other class already gets): no finding.
- **Record has number N, photo has number N, values genuinely differ**:
  `severity: 'material', reason: 'text'`. This is the case this design
  exists for — see §1's rationale for why a same-number mismatch is
  trusted as material rather than softened: the number is an independent
  structural confirmation of position, removing the ambiguity that made
  `listItem`'s own same-position mismatches only tolerant.
- **Photo has a number the record never had**: `severity: 'material',
  reason: 'added'` — mirrors every `STRICT` class's existing added-pass,
  extended the same way `listItem`'s was.

## 5. Honest limits

- **A removal that leaves no mismatched neighbor is not caught.**
  `1-altered.jpg`'s item 9 (isolated by its own removal, after the
  bounding-rule trade-off in §2) reads as tolerant "missing," not
  material. A pure removal with nothing to compare it against remains the
  same fundamentally ambiguous case `listItem` already accepts. Explored
  and rejected: detecting the renumbering cascade itself as a signal —
  defeated trivially by anyone retypesetting the whole page (exactly what
  produced these real photos), which leaves no structural discontinuity to
  find. A global list-range heuristic (trust an isolated line if its
  number falls within a range already confirmed elsewhere) was considered
  and explicitly deferred, not attempted — see §6.
- **The record's own last numbered item is never extracted, and is
  therefore invisible to comparison entirely — not just softened to
  tolerant.** This is the more significant limit, found via
  `1-altered-c.jpg`: nothing locally distinguishes "end of a numbered
  list, followed by ordinary prose" from "a wrapped continuation of the
  current item," which is exactly the ambiguity the bounding rule exists
  to refuse. The record's own item 18 has this same shape (followed by
  "Services rendered by permanent personnel...", not another marker, and
  not literally the page's last line), so it never becomes a token on
  either side. A future, deliberate substitution at a document's final
  numbered item — not only a removal — would go undetected by this
  design, the one alteration shape it cannot see at all rather than only
  softening.
- **Only a plain `N.` marker is recognized**, 1-2 digits. No `N)`, no
  Roman numerals, no lettered sub-items.
- **The bounding rule is a heuristic tuned against two real documents, not
  a proof.** A third document type with a different wrapping style could
  need it revisited.

## 6. Out of scope

- **The global-range heuristic** floated as a stronger alternative to
  local bounding — recovers the isolated-item case in §5 in principle, but
  needs its own verification round and was explicitly deferred pending
  real-world evidence of how often the gap it would close actually
  matters, per the recommendation this design was approved on.
- **Any change to `GLYPH_FOLD`, `foldLetterNoise`, `isWrapPrefix`, or any
  existing class's extraction pattern.** This design adds one new class
  and one new dedicated comparison pass; nothing already reviewed changes
  behavior.
- **Numbered sub-items inside a `field` or `listItem` value.** Out of
  scope; not observed in any real document.

## 7. Testing

- **Extraction**: a two-column line splits into two correctly-bounded
  items; a marker with no same-line neighbor and no marker-starting next
  line is not extracted (the wrapped-clause case); the same shape IS
  extracted when the next line does start with a marker, or when it's the
  last line of the text.
- **`keyFor`**: a `numberedItem` value folds through the same path as
  `name`/`field`/`listItem`.
- **`compareNumberedItems`**: same-number exact match → no finding;
  same-number wrap-prefix (trailing OCR noise) → no finding; same-number
  genuine mismatch → material, reason `text`; record number missing from
  photo → tolerant, reason `missing`; photo number absent from record →
  material, reason `added`.
- **Real-photo calibration, both fixture sets**: `test/fixtures/pages/`
  (legal-clause document) — zero `numberedItem` tokens extracted anywhere,
  record or any of its 3 genuine photos; zero behavior change from
  before this design. `test/fixtures/pages-special-order-383/` — the
  genuine photo shows zero material `numberedItem` findings;
  `1-altered-b.jpg` and `1-altered-d.jpg` each report their real name
  substitution as material; `1-altered.jpg` and `1-altered-c.jpg` are
  confirmed to still report `CAUGHT NOTHING` for the numbered-list
  alteration specifically (the accepted §5 limit — verified as expected,
  not treated as a bug).
