# LeafCode — Custom 2D Symbology (Proof of Concept) — Design

**Date:** 2026-07-23
**Status:** Approved design, pre-implementation (proof of concept)
**Relation to product:** Parallel experiment. Does NOT touch the sealer or the
shipping mark. The leaf-**QR** remains the production per-page code until LeafCode
clears the feasibility gates below.

## 1. Purpose

Explore a bespoke, EMB-exclusive machine-readable 2D code — a leaf-shaped
constellation of nodes with triangular anchors — that CerVer (and only CerVer)
can decode. This is a research-grade effort with real reliability risk; the goal
of the PoC is to answer *"can we decode our own symbology reliably enough to be
worth it?"* before investing further.

## 2. Honest constraints

- Node classification (solid vs hollow) from a phone photo is the fragile part;
  blur and lighting degrade it. Expect materially lower robustness than QR.
- 3 anchors give an **affine** rectification (rotation/scale/shear), not full
  perspective. Acceptable for near-perpendicular flat scans; a 4th anchor for
  perspective is a later stretch goal, out of PoC scope.
- Pure JS, no native deps, CSP-safe (canvas `ImageData` only).

## 3. Symbology structure

- **Fixed shared lattice.** A deterministic Poisson-disc layout of **256 node
  positions** inside a fixed leaf silhouette, generated from a hardcoded seed and
  ordered by a stable rule (sort by `u` then `x`). Encoder and decoder derive the
  identical positions. Organic-looking, fully known.
- **3 triangular anchors** at fixed lattice-space positions (near tip, lower-left
  edge, base), filled, ~35% larger than nodes, forming a **scalene** triangle so
  the three inter-anchor distances are all distinct → unambiguous labeling and
  orientation.
- **1 bit per node:** solid dot = 1, hollow ring = 0. Tunable fallback:
  dot-present vs dot-absent, if hollow/solid proves unreliable on photos.
- Midrib, secondary veins, and inter-node connecting lines are **decorative
  only** — the decoder ignores them.

## 4. Capacity & error correction

- 256 nodes = **32 bytes** total (codeword).
- **Data = 12 bytes**: a 2-byte header (magic + version, for format detection and
  rejecting non-LeafCode blobs) + 10 bytes payload — the compact binary form of
  `iisNo | k | seal` (year 2B + serial 3B + page 1B + seal 4B ≈ 10 bytes).
- **Reed–Solomon over GF(256)**: 12 data bytes → 32-byte codeword ⇒ **20 parity
  bytes, correcting up to 10 byte errors**. Deliberately heavy redundancy, since
  node classification will be noisy.

## 5. Components (isolated, single-purpose, testable)

- **`src/leafcode/gf256.js`** — GF(256) arithmetic (exp/log tables, mul/inv).
- **`src/leafcode/rs.js`** — Reed–Solomon `rsEncode(dataBytes, nsym)` /
  `rsDecode(codeBytes, nsym) -> dataBytes | null`. Consumes `gf256`.
- **`src/leafcode/lattice.js`** — `lattice() -> { nodes: [{x,y}]×256, anchors: [{x,y}]×3, leaf: outlineParams }` in canonical leaf coordinates. Deterministic.
- **`src/leafcode/encode.js`** — `encode(payloadStr) -> Uint8Array bits[256]`.
  Packs payload → RS encode → bit array aligned to lattice order.
- **`src/leafcode/decodeBits.js`** — `bitsToPayload(bits[256]) -> payloadStr | null`.
  Inverse of encode (RS decode + unpack). Split from image decoding so it is
  unit-testable without pixels.
- **`src/leafcode/render.js`** — `renderSvg(bits) -> string`. Draws leaf outline,
  veins, anchors, and nodes (solid/hollow) at lattice positions. Black on white,
  high contrast.
- **`src/leafcode/decode.js`** — image decoder:
  `decode(imageData) -> payloadStr | null`:
  1. grayscale + Otsu threshold
  2. connected-component blobs (centroid, area, fill ratio)
  3. locate 3 anchors (largest triangular/filled blobs; label by scalene
     distances)
  4. affine transform: canonical anchor coords → image coords, invert
  5. for each of 256 canonical node centers, map into the image, sample a small
     disc, classify solid/hollow (center-darkness threshold)
  6. `bitsToPayload` (RS decode). Return payload or null.
- **`public/leafcode-bench.html`** + **`public/leafcode-bench.js`** — a bench page:
  encode a sample payload → render → decode; sliders to inject blur / rotation /
  scale / noise and show live decode success. Not linked from the app.

## 6. Feasibility gates (kill-switch)

- **Gate A — clean round-trip (automated test).** `encode → renderSvg →
  rasterize → decode` returns the exact payload **100%** on the pristine image.
  Proves lattice + RS + classifier correctness. *Must pass before B/C.*
- **Gate B — synthetic degradation (automated harness).** Inject Gaussian blur,
  downscale, rotation (±15°), mild perspective warp, and JPEG-style noise; report
  decode rate per condition. Success bar: high pass under *mild* degradation.
- **Gate C — real photo.** Decode a printed LeafCode from a phone/webcam capture.
  The honest field test.

If Gate A is not solid or Gate B is poor under mild conditions, we **stop** and
keep the leaf-QR. Decision recorded before any camera/UI integration.

## 7. Testing

- `gf256`, `rs` — unit tests (encode/decode, correct N errors, fail past
  capacity).
- `lattice` — determinism (same output across runs) + all nodes inside leaf +
  anchors scalene.
- `encode`/`bitsToPayload` — round-trip; RS corrects injected bit flips.
- Gate A — automated `encode→render→decode` round-trip test (headless raster via
  the existing Playwright/Chrome path).
- Gate B — degradation harness producing a metrics table (not a pass/fail unit
  test; a reported measurement to make the go/no-go call).

## 8. Build order

1. `gf256` + `rs` (+ tests).
2. `lattice` (+ determinism tests).
3. `encode` + `bitsToPayload` (+ round-trip tests).
4. `render` (SVG).
5. `decode` (image pipeline).
6. **Gate A** automated round-trip — go/no-go.
7. Bench page + **Gate B** degradation metrics — go/no-go.
8. (Only if A/B pass) camera integration + **Gate C**; then a separate decision
   about production use.

## 9. Explicitly out of scope (this PoC)

- Any change to the sealer, the shipping mark, or the verify flow.
- 4-anchor perspective correction; multi-state (size) nodes.
- Live camera integration and UI wiring (gated behind A/B success).
- Replacing the leaf-QR in production (a separate decision after Gate C).
