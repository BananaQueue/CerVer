# EMB Seal Code — Stroke-Tolerant Registration — Design

**Date:** 2026-08-12
**Status:** Approved design, pre-implementation
**Extends:** `2026-07-23-per-page-sealing-design.md`

## 1. Problem

A ballpen stroke or a smudge that **extends past the mark's silhouette** makes the
page unreadable. Ink *on* the mark is already tolerated; ink that pokes *out* of
it is fatal.

Measured on a real phone capture (`frames/frame-2026-08-12T03-01-43-593Z.png`,
934x700, 10.8 px/tile, mark complete and well lit, one pen stroke crossing into
the disc from the lower left):

```
as captured -> fail, 41% fixed-tile match, angle 133 deg
```

## 2. Cause

`locate()` in `src/sealcode/decode.js` derives the mark's bounding box from ink
**extents**. Every candidate box — `box(cluster)`, `box(near)`, `box(big)`,
`box([biggest])` — is an extent box, and the stroke touches the disc, so it joins
the largest component and inflates all four. The baseline artwork is then fitted
to the wrong rectangle, and every tile is sampled off-grid.

Isolated dirt is already handled: a speck that touches nothing is dropped by the
`MIN_PART` 2% filter. Only ink that *connects* to the mark and extends it hurts.

## 3. Why error correction cannot cover this

RS with 11 data bytes in a 35-byte codeword corrects **12 byte errors**.
Registration error is not sparse, it is correlated: once the sampling grid slips
half a tile at the rim, every rim carrier flips together.

Measured (pure geometry, `truth` grid sampled through a rotation):

| grid off by | bytes wrong of 35 | within budget of 12 |
|---|---|---|
| 0–1.5° | 0 | yes |
| 2° | 20 | no |
| 3° | 33 | no |
| 5° | 35 (total) | no |

The cliff sits at **1.80°**, against 2.7° subtended by one rim tile. There is no
graceful zone.

Nor can it be bought with more parity. Covering 20 byte errors needs a 51-byte
codeword — 408 bits — against **305 carrier tiles in the whole mark**. It does not
fit. This is a capacity wall, not a tuning choice.

The corollary is that error correction is already doing its job well: a long pen
stroke driven straight through the mark's interior, damaging many tiles but never
crossing the silhouette, decodes at **96–98%**.

## 4. Approach

On failure, **retry the whole decode on a run-length-trimmed region**.

A pen stroke is *thin*: one tile wide against artwork features many tiles wide.
So trim inward from each edge while the longest ink run in that row or column
falls below a threshold, and decode again inside what is left.

Three properties make this fit the existing design:

1. **Selection is already solved.** The best result wins on fixed-tile score. A
   bad trim loses; it cannot make things worse.
2. **No threshold to tune.** Several thresholds are tried and the score decides.
3. **No cost on the happy path.** The retry runs only when the ordinary boxes
   have already failed. Measured: clean mark 82 ms (unchanged), real pen capture
   440 ms, page clutter with no seal 166 ms.

### Why a retry and not just another candidate box

The first implementation passed trimmed rectangles to the existing fitter as
extra candidates. It did not work — 41% to 59%, still no read. Confining the
component clustering to the trimmed region as well got no further.

The reason is that the local threshold window is derived from the image's own
size (`min(w,h)/12`). Decoding a trimmed *region* re-derives that window against
the region, which binarizes the mark differently — and better — than a window
scaled to the whole frame. Both halves are needed: clustering that cannot see
the tail running off the mark, **and** a threshold re-adapted to the region.

This was not foreseen. The validation that justified this design cropped the
image before re-decoding, so it silently exercised both effects and was read as
evidence for the weaker one. Recorded because the same confound would recur in
any future attempt to make this cheaper by refitting instead of re-decoding.

### Threshold estimation

Thresholds are multiples of an estimated tile size, so they hold at any capture
distance:

```
tile ~= min(boxW, boxH) / N        // N = 44
thresholds = tile * [1, 2, 3, 4, 5, 6, 8]
```

`min` rather than `max`, because a stroke inflates one axis and rarely both. On
the real frame the raw ink box is 677x477: width is inflated, height is not, and
`min(677,477)/44 = 10.8 px` — the true pitch to one decimal place.

Measured on that frame, thresholds that recover the payload are 35–40 px and
65 px; the multiples above give 11, 22, 33, 43, 54, 65, 87, bracketing both.

### Control flow

```
decodeCore(img, depth = 0):
    for each threshold mode:                          # unchanged fast path
        for each of [cluster, near, big, biggest]:
            if it decodes: return it
    if depth > 0: return best                         # a retry does not retry
    tile = min(inkBoxW, inkBoxH) / N
    for k in [1,2,3,4,5,6,8]:
        region = runTrimBox(bin, w, h, tile * k)
        got = decodeCore(crop(img, region), depth + 1)
        if got decodes: return got
    return best
```

Trim rectangles are de-duplicated across the two threshold modes, which usually
agree.

## 5. Honest limits

- **Score is necessary but not sufficient.** On the real frame, boxes scoring
  87–89% (2° off) cleared `MIN_FIXED_MATCH` and still failed to decode. The
  fallback works because a 99% candidate is present and wins on score, not
  because 72% is a reliable predictor of a decode.
- **A stroke wider than the threshold band is not trimmed.** A marker pen (over
  ~2 mm at 16 mm) reads as a legitimate feature.
- **A stroke running parallel and adjacent to the mark's edge** lengthens runs
  rather than looking thin, and will not be trimmed.
- **Failing frames cost 2–5x more** (82 ms to 166–440 ms on a desktop, more on a
  phone). Failing frames produce no output anyway, and the capture loop's `busy`
  guard drops frames rather than queueing them — but while aiming at a marked
  page the on-screen diagnostic updates roughly once a second instead of every
  frame.
- Only **one** real capture exercises this. Every other data point is synthetic,
  and synthetic strokes already misled once: they showed the trim to be
  insensitive to threshold, where the real capture reads at only 3 of 17
  thresholds.

## 6. Testing

- **Regression fixture (the point of the exercise).** The real capture is copied
  to `test/fixtures/` and must decode to `CVR|R1-2026-001024|2|36DK-GKFW`,
  confirmed against the footer printed on the same page (`p2/2 · K1 ·
  36DK-GKFW`). It fails before the change.
- Clean synthetic mark still decodes — the fallback must not disturb the fast
  path.
- Synthetic protruding strokes (left stub, bottom stub, both diagonals,
  straight across) decode.
- A capture with no seal in it still returns no payload, so the extra candidates
  do not manufacture a false read.

## 7. Out of scope

- The **pen-stroke erasure map** (using contaminated regions to drive RS erasure
  decoding, doubling the correction budget). Only worth doing if registration
  succeeds and bit errors then dominate, which is not the failure being seen.
- Re-photographing the size ladder now that capture geometry is honest.
- `send.html`'s separate progressive-centre-crop capture path. (Moot as of
  2026-08-12: that page has been removed.)
