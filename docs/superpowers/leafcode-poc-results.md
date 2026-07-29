# LeafCode — Proof of Concept Results

**Date:** 2026-07-29
**Branch:** `leafcode-poc`
**Spec:** `docs/superpowers/specs/2026-07-23-leafcode-design.md`
**Plan:** `docs/superpowers/plans/2026-07-23-leafcode.md`

## Question the PoC set out to answer

Can CerVer define and decode its own bespoke 2D symbology — a leaf-shaped
constellation of dots — reliably enough to be worth pursuing, instead of using a
standard QR/Data Matrix?

The PoC was explicitly built with a kill-switch (Gate A) so it could be abandoned
cheaply if the answer was no.

## Verdict: **GO for continued development — but NOT yet for production use.**

Both automated gates passed cleanly. The decisive remaining unknown (Gate C, real
print + camera) has not been tested, and that is the honest gap.

---

## What was built

| Module | Responsibility |
|---|---|
| `src/leafcode/gf256.js` | GF(2^8) field arithmetic (poly 0x11d, generator 2) |
| `src/leafcode/rs.js` | Reed–Solomon codec (Berlekamp–Massey → Chien → Forney) |
| `src/leafcode/lattice.js` | Deterministic 256-node leaf lattice + 3 scalene anchors |
| `src/leafcode/codec.js` | Payload ⇄ 256 bits (13 data bytes + 19 parity) |
| `src/leafcode/raster.js` | Pure-JS pixel rasterizer (headless test double) |
| `src/leafcode/decode.js` | Image decoder (Otsu → blobs → anchors → affine → sample) |
| `src/leafcode/render.js` | Printable SVG artwork |
| `src/leafcode/degrade.js` | Degradation harness (blur/rotate/scale/noise) |
| `scripts/leafcode-parity.mjs` | Proves the real SVG decodes via headless Chrome |

**60 automated tests pass** (103 including the production suite). No new npm dependencies were added (Node built-ins
only); Playwright was already present for the parity check.

### Symbology as built

- **256 node positions** on a fixed, deterministic Poisson-disc lattice (seed
  `0x1EAF`) inside a leaf silhouette; canonical space 1000×1000, minimum node
  spacing 24 units.
- **1 bit per node** — solid disc = 1, hollow ring = 0.
- **3 filled triangular anchors** forming a scalene triangle (sides ≈ 512.4 /
  224.0 / 664.2), giving unambiguous orientation. Anchors are the largest marks
  by pixel area and carry 40 units of clearance from any data node.
- **Payload:** 13 data bytes = 2-byte header + year(2) + serial(3) + page(1) +
  seal(5, eight base32 chars at 5 bits). Reed–Solomon `nsym=19` → 32-byte
  codeword → 256 bits. **Corrects up to 9 corrupted bytes of 32.**
- Decoration (leaf outline, midrib, veins) is drawn light and low-opacity, with a
  white clearance halo under every mark, so it cannot interfere with decoding.

---

## Gate A — clean round-trip (the kill-switch)

**PASSED — 100%.**

6 payloads spanning the field space (years 1999–2099, serials `000001`–`999999`,
pages at both boundaries 1 and 255, seals exercising letters and digits) across
canvas sizes 800/1000/1200/1600 → **30/30 exact round-trips.**

## Gate B — synthetic degradation

**PASSED — 100% on every required condition** (5 payloads each, rendered at
px=1000):

| Condition | Rate |
|---|---|
| control (undegraded) | 100% |
| blur radius 1 / 2 / 3 / 4 | 100% |
| rotate 5° / 15° / 30° / 45° / 90° | 100% |
| scale-down /1.5 / /2 / /3 / /4 | 100% |
| noise 20 / 40 / 60 / 80 [^noise] | 100% |
| combo: blur1+rot5+noise20 (light photo) | 100% |
| combo: blur2+rot15+noise40 (typical photo) | 100% |
| combo: blur2+rot30+scale2+noise40 (poor photo) | 100% |
| combo: blur3+rot45+scale3+noise60 (bad photo) | 100% |

[^noise]: **Not an independent robustness axis** — see "On the noise results"
    in the limitations section below. These rows are structurally guaranteed
    to pass by the synthetic model and are not evidence of decoder
    robustness the way the blur/scale/rotate rows are.

**Measured cliffs beyond the required sweep:**

- blur: r4 = 100% → **r5 = 0%**
- scale-down: /4 = 100% → **/4.2 = 0%** ← thinnest margin of any axis
- noise: 110 = 100% → **115 = 0%** (stable across 5 seeds) — see "On the noise
  results" below; this cliff is a property of `degrade.js`'s noise model, not
  a measurement of decoder robustness.
- rotation: **every angle 1°–180° decoded at 100%** — the three-anchor affine
  solve is genuinely rotation-invariant.

## SVG parity

The printable SVG — not just the test double — was rasterized in **real headless
Chrome** and decoded: 3 payloads × 2 canvas sizes = **6/6 exact**. Geometry
between `render.js` and `raster.js` matched with no drift.

---

## Honest limitations

These bound how far the Gate B result should be trusted.

**On the noise results.** `raster.js` emits a perfectly bimodal image — every
pixel is either exactly 0 or exactly 255, with nothing in between — and
`degrade.js`'s `noise()` adds uniform additive noise of amplitude *a* to each
pixel independently. For any *a* ≤ 110, the two pixel classes stay strictly
disjoint (the dark class lands in [0, 110], the light class in [145, 255]),
so **any** global threshold placed between them — not just Otsu's, literally
any fixed cutoff — separates the classes perfectly. The 100% pass rate on
every noise row above is therefore **guaranteed by the structure of the
synthetic test image**, not a measurement of the decoder's robustness to
noise. Likewise the "110 → 115" cliff is not the decoder's classifier
breaking down; it is simply the amplitude at which the two synthetic pixel
classes first start to overlap. A real photograph is never perfectly
bimodal (sensor noise, JPEG artifacts, and halftoning all produce a
continuous grey distribution), so this axis says nothing about how the
decoder will behave on a real capture. The noise rows are kept in the table
for completeness, not deleted, but should not be read as an independent
robustness axis alongside blur/scale/rotation, which do meaningfully stress
the decoder.

1. **Gate C (real print + camera) was never run.** Everything above degrades a
   *synthetic* raster with *synthetic* transforms. Not represented: lens optics,
   uneven lighting and shadow gradients, specular glare on paper, JPEG
   compression artifacts, printer halftoning, ink bleed, or paper texture.
   **This is the decisive untested risk.**
2. **The decoder is affine-only.** Three anchors recover rotation, scale, and
   shear — but *not* perspective. A photo taken at an angle to the page induces
   projective distortion that this decoder cannot correct. A real handheld
   capture is rarely perfectly perpendicular. A 4th anchor would be needed.
   Measured: perspective keystoning actually survives up to k≈0.1 and only
   fails at k≈0.2, so this limitation as stated is slightly **pessimistic**
   rather than optimistic — the affine solve has more slack for mild
   perspective than the "affine-only" framing implies. Erring safe here is
   fine, but worth knowing.
3. **Failure is a sharp cliff, not a graceful decline.** Every axis goes
   100% → 0% within a narrow band. There is no "partial read" warning zone, so a
   marginal capture fails outright rather than degrading visibly.
4. **Density is low.** 256 nodes carry 13 useful bytes. A QR of similar physical
   size carries far more, with far better-tested error correction.
5. **A lighting gradient defeats the single global Otsu threshold.** Measured:
   at gradient strength ≈0.6, 0/3 payloads decoded. A single global threshold
   cannot separate dark marks from light background when illumination varies
   enough across the page — this concretely supports the "no lighting
   gradients" concern in limitation 1 and the recommendation (below) to add
   local/adaptive thresholding; it is expected to be a real problem under
   uneven real-world lighting (a risk Gate C would need to confirm).
6. **Only CerVer can read it.** No off-the-shelf scanner, phone camera app, or
   other agency's system can decode a LeafCode. That is the point (exclusivity),
   but it is also an operational liability.
7. **Scale-down margin is thin** (/4 passes, /4.2 fails), which is the axis most
   directly analogous to "photographed from too far away".

---

## Addendum (2026-07-29): stamping it on a real page

The LeafCode was wired into the sealer as an opt-in mark (`mark=leafcode|both`)
and stamped onto a real sealed PDF, tilted with a stem. Two findings, both
measured rather than estimated:

**1. Decoration must be nearly white.** On a rendered page the decoder's crop is
overwhelmingly white paper, so Otsu's threshold lands high (**measured 213**).
Decoration at grey 170 was therefore still classified *dark*, and because a leaf
outline is one continuous stroke it bridged neighbouring dots into a single
**23,049 px** blob — swamping the anchors and failing the decode outright.
Pushing the outline and stem to ~grey 235 resolved that specific failure.

**2. The mark is far too large to be practical.** Decode rate off an actual
rendered page at ~2.66 px/pt (≈190 dpi capture):

| Leaf size | Physical | Decodes |
|---|---|---|
| 110 pt | 39 mm | no |
| 140 pt | 49 mm | no |
| 170 pt | 60 mm | no |
| 200 pt | 71 mm | **yes** |

The earlier "~300 px minimum" figure came from the *synthetic* rasterizer, which
has no anti-aliasing and no capture blur. On a real page those effects merge
adjacent dots long before that limit — at 110 pt, single blobs measured 6,000+ px
where one dot should be ~110 px.

**Consequence:** at ~190 dpi capture the leaf needs to be about **7 cm** — a
quarter of the page width — to decode, versus **15 mm** for the Data Matrix
carrying the same payload. The 256-node lattice is simply too dense for a
page-appropriate mark. Making it smaller requires redesigning the symbology with
far fewer, larger nodes (fewer bits and/or less error correction), or restricting
verification to high-resolution scans rather than phone captures.

## Recommendation

**Keep the standard leaf-QR as the production per-page mark.** It scans with any
device, survives photocopying, and is backed by decades of engineering. Nothing
in this PoC justifies replacing it today.

**LeafCode has earned continued development, not deployment.** The next step, if
pursued, is in this order:

1. **Gate C** — print a LeafCode, photograph it with a real phone at several
   angles and lighting conditions, and measure. This is cheap and will answer the
   real question. Expect failures from perspective distortion.
2. **Add a 4th anchor and a projective (homography) solve** — almost certainly
   required for handheld capture.
3. Add local/adaptive thresholding instead of a single global Otsu, to survive
   lighting gradients across the page.
4. Only then consider a camera/UI integration or any production role.

## Deliberately not built

- **Task 10 (bench page)** was skipped as unnecessary: the parity script and
  preview renderer already provide the same feedback without adding a served dev
  page. Noted rather than silently dropped.
- Multi-state nodes (size/fill combinations) remain out of scope — 1 bit/node
  was chosen deliberately for decodability.

## Known issues remaining (accepted, not blocking)

The final whole-branch review triaged these as documented known issues rather
than defects to fix. All other review findings were fixed before the branch was
kept.

- `rs.js`: Berlekamp–Massey lacks the canonical leading-zero trim on the error
  locator (can overstate degree → a spurious `null`, never corrupt output), and
  the `synd[i-j]` access relies on an undocumented invariant `deg(errLoc) <= i`
  — an out-of-bounds read would silently poison the discrepancy with `undefined`
  rather than throwing. Neither is reachable at `nsym = 19`: 27,000 randomised
  within-capacity trials produced 0 spurious nulls and 0 wrong outputs, and
  4,000 over-capacity trials returned `null` every time with 0 miscorrections.
  Worth a one-line guard if the RS codec is ever reused at a different `nsym`.
- No committed test pins the "`rsDecode` must not mutate the caller's array"
  contract, though the contract was verified to hold.

**Guard added:** `test/leafcode/geometry.test.js` now fails loudly if the
geometry constants duplicated across `lattice.js`, `raster.js`, `render.js` and
`decode.js` ever drift apart — previously only the browser-dependent parity
script would have caught that, and it is not part of `node --test`.
