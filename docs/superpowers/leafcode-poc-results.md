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

**53 automated tests pass.** No new npm dependencies were added (Node built-ins
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
| noise 20 / 40 / 60 / 80 | 100% |
| combo: blur1+rot5+noise20 (light photo) | 100% |
| combo: blur2+rot15+noise40 (typical photo) | 100% |
| combo: blur2+rot30+scale2+noise40 (poor photo) | 100% |
| combo: blur3+rot45+scale3+noise60 (bad photo) | 100% |

**Measured cliffs beyond the required sweep:**

- blur: r4 = 100% → **r5 = 0%**
- scale-down: /4 = 100% → **/4.2 = 0%** ← thinnest margin of any axis
- noise: 110 = 100% → **115 = 0%** (stable across 5 seeds)
- rotation: **every angle 1°–180° decoded at 100%** — the three-anchor affine
  solve is genuinely rotation-invariant.

## SVG parity

The printable SVG — not just the test double — was rasterized in **real headless
Chrome** and decoded: 3 payloads × 2 canvas sizes = **6/6 exact**. Geometry
between `render.js` and `raster.js` matched with no drift.

---

## Honest limitations

These bound how far the Gate B result should be trusted.

1. **Gate C (real print + camera) was never run.** Everything above degrades a
   *synthetic* raster with *synthetic* transforms. Not represented: lens optics,
   uneven lighting and shadow gradients, specular glare on paper, JPEG
   compression artifacts, printer halftoning, ink bleed, or paper texture.
   **This is the decisive untested risk.**
2. **The decoder is affine-only.** Three anchors recover rotation, scale, and
   shear — but *not* perspective. A photo taken at an angle to the page induces
   projective distortion that this decoder cannot correct. A real handheld
   capture is rarely perfectly perpendicular. A 4th anchor would be needed.
3. **Failure is a sharp cliff, not a graceful decline.** Every axis goes
   100% → 0% within a narrow band. There is no "partial read" warning zone, so a
   marginal capture fails outright rather than degrading visibly.
4. **Density is low.** 256 nodes carry 13 useful bytes. A QR of similar physical
   size carries far more, with far better-tested error correction.
5. **Only CerVer can read it.** No off-the-shelf scanner, phone camera app, or
   other agency's system can decode a LeafCode. That is the point (exclusivity),
   but it is also an operational liability.
6. **Scale-down margin is thin** (/4 passes, /4.2 fails), which is the axis most
   directly analogous to "photographed from too far away".

---

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

## Minor issues deferred from task reviews

- `rs.js`: Berlekamp–Massey lacks the canonical leading-zero trim on the error
  locator (can overstate degree → spurious `null`, never corrupt output); the
  `synd[i-j]` access relies on an undocumented invariant worth a guard or comment;
  no committed test pins the "must not mutate caller's array" contract.
- `raster.test.js`: a confusing `const s = px / px; // 1` should read `px / SPACE`.
- `decode.test.js`: no test exercises a rotated/skewed capture, though Gate B
  covers rotation.
