# Capture Quality Check Implementation Plan

**Status:** Implemented and verified 2026-09-09. Task 2 Step 4's manual check
couldn't drive the native OS file-picker dialog through browser automation,
so it was verified instead by dispatching a real `change` event on
`#pageImage` with a `DataTransfer`-constructed `File` built from the actual
fixture bytes (fetched same-origin after a temporary copy into `public/`,
removed afterward) — this exercises the exact same shipped `onchange`
handler, `assessFileQuality`, and `assessCaptureQuality` a real pick would,
just skipping the unautomatable OS dialog step. Both the genuine fixture and
a real backlit test photo passed through with zero false positives, as
expected.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before a picked page photo is uploaded for comparison, warn the user (without blocking) if it looks blurry or badly exposed, so a bad capture can be retaken before it ever reaches OCR.

**Architecture:** A pure, dependency-free scoring module (`public/captureQuality.js`, same pattern as the existing `public/coverRect.js`) computes a blur-variance score and an exposure classification from a plain grayscale pixel array — fully testable in Node with no DOM. `public/app.js` gets a small canvas-glue function that turns the picked `File` into that grayscale array (downscaled for speed), calls the scoring module, and — only if flagged — renders an inline "retake or continue anyway" prompt in `#ocrOut` before the existing upload path runs. If the check fails for any reason, or passes clean, behavior is byte-for-byte what it is today: straight to upload.

**Tech Stack:** Plain browser JS (Canvas 2D API for pixel access), Node's built-in `node:test` for the pure module.

**Spec:** No separate spec file — this is a bounded change (single existing flow, one new small module); design was agreed in chat during brainstorming on 2026-09-09. Two real spikes earlier the same day (CLAHE local-contrast correction, naive brightness-based auto-crop) were tried and rejected as net-harmful against real photos — this plan deliberately does NOT attempt to correct or crop the image, only to flag it before upload.

## Global Constraints

- Advisory only — never blocks the existing upload path. A wrong threshold costs an unnecessary prompt (or a missed one), never a changed finding or verdict.
- No new dependency. Canvas 2D API only, already available in every browser this app targets (it's already used elsewhere for `drawPhotoWithBoxes`).
- Thresholds are explicitly provisional — no real blurry or genuinely-too-dark photo has been available to calibrate against (documented in the module itself, same convention as `BOX_CONFIDENCE_FLOOR` in `public/app.js`).
- The blur-variance threshold is tied to a fixed downscale width (500px) — the glue code MUST downscale to that exact width before calling `assessCaptureQuality`, or the threshold is meaningless.

---

## Task 1: Pure capture-quality scoring module

**Files:**
- Create: `public/captureQuality.js`
- Test: `test/captureQuality.test.js`

**Interfaces:**
- Produces:
  - `blurVariance(gray: Uint8ClampedArray | number[], width: number, height: number): number`
  - `exposureIssue(gray: Uint8ClampedArray | number[]): 'dark' | 'bright' | null`
  - `assessCaptureQuality(gray: Uint8ClampedArray | number[], width: number, height: number): { blurry: boolean, exposure: 'dark' | 'bright' | null }`
- Consumes: nothing (pure functions, plain arrays in and out).

- [x] **Step 1: Write the failing tests**

Create `test/captureQuality.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { blurVariance, exposureIssue, assessCaptureQuality } from '../public/captureQuality.js';

function uniform(value, width, height) {
  return new Uint8ClampedArray(width * height).fill(value);
}

function checkerboard(width, height) {
  const g = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      g[y * width + x] = (x + y) % 2 === 0 ? 0 : 255;
    }
  }
  return g;
}

test('a perfectly flat image has zero blur variance', () => {
  assert.equal(blurVariance(uniform(128, 20, 20), 20, 20), 0);
});

test('a high-contrast checkerboard has large blur variance', () => {
  assert.ok(blurVariance(checkerboard(20, 20), 20, 20) > 10000);
});

test('assessCaptureQuality flags a flat image as blurry', () => {
  const result = assessCaptureQuality(uniform(128, 20, 20), 20, 20);
  assert.equal(result.blurry, true);
});

test('assessCaptureQuality does not flag a sharp checkerboard as blurry', () => {
  const result = assessCaptureQuality(checkerboard(20, 20), 20, 20);
  assert.equal(result.blurry, false);
});

test('a dark image is flagged by mean brightness', () => {
  assert.equal(exposureIssue(uniform(20, 10, 10)), 'dark');
});

test('a bright/blown-out image is flagged by mean brightness', () => {
  assert.equal(exposureIssue(uniform(250, 10, 10)), 'bright');
});

test('a normal midtone image is not flagged', () => {
  const g = new Uint8ClampedArray(200);
  for (let i = 0; i < g.length; i++) g[i] = i % 2 === 0 ? 100 : 140;
  assert.equal(exposureIssue(g), null);
});

test('a bimodal image with a normal mean is still flagged via clipped-pixel fraction', () => {
  // 60% pure black, 40% pure white -- mean lands at 102 (inside the normal
  // 60-235 range) but the dark side alone clips well past the 50% guard, so
  // a photo that is mostly black with a blown-out patch must not read as fine.
  const g = new Uint8ClampedArray(100);
  for (let i = 0; i < 60; i++) g[i] = 0;
  for (let i = 60; i < 100; i++) g[i] = 255;
  assert.equal(exposureIssue(g), 'dark');
});

test('an empty array is not flagged (nothing to judge)', () => {
  assert.equal(exposureIssue(new Uint8ClampedArray(0)), null);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node --test test/captureQuality.test.js`
Expected: FAIL — `public/captureQuality.js` does not exist yet (module not found).

- [x] **Step 3: Write the implementation**

Create `public/captureQuality.js`:

```js
// Advisory capture-quality signals, computed from a plain grayscale pixel
// array so this module has no DOM/canvas dependency and is directly
// testable in Node -- same separation as coverRect.js.
//
// These never block or change a finding: a wrong call here costs an
// unnecessary "retake?" prompt (or a missed one), nothing more. That is
// what makes it acceptable to ship these thresholds PROVISIONAL -- unlike
// MIN_CONFIDENCE (src/verifyPageImage.js) or THRESHOLDS (src/pageCompare.js),
// which are measured against real genuine/altered photo pairs because they
// change what counts as evidence, no real blurry or genuinely-too-dark
// photo was available to calibrate against as of 2026-09-09. Tighten these
// against real false positives/negatives as they turn up, the same way
// BOX_CONFIDENCE_FLOOR is expected to move.
//
// blurVariance's scale depends on image size -- callers MUST downscale to
// the same fixed width (500px, see app.js's assessFileQuality) before
// calling, or this threshold means nothing.
const BLUR_VARIANCE_THRESHOLD = 50;
const DARK_MEAN_THRESHOLD = 60;
const BRIGHT_MEAN_THRESHOLD = 235;
const CLIP_FRACTION_THRESHOLD = 0.5;

/**
 * Variance of a simple 4-neighbor Laplacian -- the standard cheap
 * sharpness proxy. Sharp edges (printed text) push interior pixels far
 * from their neighbors' average, so variance is high; a blurred photo
 * smooths those differences away, so variance collapses toward zero.
 * @param {Uint8ClampedArray | number[]} gray
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function blurVariance(gray, width, height) {
  const values = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      values.push(lap);
    }
  }
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
}

/**
 * Classifies overall exposure from a grayscale pixel array. Checks both
 * the mean (catches a uniformly dark or blown-out photo) and the fraction
 * of pixels clipped at the extremes (catches a bimodal photo -- e.g. a
 * harsh shadow across half the frame -- whose mean alone would look fine).
 * @param {Uint8ClampedArray | number[]} gray
 * @returns {'dark' | 'bright' | null}
 */
export function exposureIssue(gray) {
  if (gray.length === 0) return null;
  let sum = 0, darkClipped = 0, brightClipped = 0;
  for (let i = 0; i < gray.length; i++) {
    sum += gray[i];
    if (gray[i] < 10) darkClipped++;
    if (gray[i] > 245) brightClipped++;
  }
  const mean = sum / gray.length;
  if (mean < DARK_MEAN_THRESHOLD || darkClipped / gray.length > CLIP_FRACTION_THRESHOLD) return 'dark';
  if (mean > BRIGHT_MEAN_THRESHOLD || brightClipped / gray.length > CLIP_FRACTION_THRESHOLD) return 'bright';
  return null;
}

/**
 * @param {Uint8ClampedArray | number[]} gray
 * @param {number} width
 * @param {number} height
 * @returns {{ blurry: boolean, exposure: 'dark' | 'bright' | null }}
 */
export function assessCaptureQuality(gray, width, height) {
  return {
    blurry: blurVariance(gray, width, height) < BLUR_VARIANCE_THRESHOLD,
    exposure: exposureIssue(gray),
  };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node --test test/captureQuality.test.js`
Expected: PASS, all 9 tests.

- [x] **Step 5: Commit**

```bash
git add public/captureQuality.js test/captureQuality.test.js
git commit -m "$(cat <<'EOF'
feat(capture): add pure blur/exposure scoring for photo capture quality

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire the check into the photo-attach flow

**Files:**
- Modify: `public/app.js:10` (imports), `public/app.js:729-745` (the `imgEl.onchange` handler inside `renderPageResult`)

**Interfaces:**
- Consumes: `assessCaptureQuality(gray, width, height): { blurry: boolean, exposure: 'dark' | 'bright' | null }` from Task 1.
- Produces: no new exports -- this task only changes `renderPageResult`'s internal wiring in `public/app.js`.

- [x] **Step 1: Add the import**

In `public/app.js`, alongside the existing `coverRect` import:

```js
import { coverSourceRect } from '/coverRect.js';
import { assessCaptureQuality } from '/captureQuality.js';
```

- [x] **Step 2: Add the canvas-glue and prompt-rendering helpers**

Add these two functions near `drawPhotoWithBoxes` (same file, same general area — both are photo/canvas helpers):

```js
// Downscaled to a fixed width so blurVariance's threshold (tuned for this
// exact size, see captureQuality.js) stays meaningful across different
// phone camera resolutions.
const QUALITY_SAMPLE_WIDTH = 500;

async function assessFileQuality(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = QUALITY_SAMPLE_WIDTH;
    const h = Math.max(1, Math.round(img.naturalHeight * (w / img.naturalWidth)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
    }
    return assessCaptureQuality(gray, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Advisory only -- both buttons lead somewhere, neither is a dead end.
// Renders into the same #ocrOut the upload flow itself uses, so a retake
// (which re-triggers the picker) naturally replaces this with the next
// photo's own report once one comes back.
function renderQualityWarning(out, quality, onContinue, onRetake) {
  const reasons = [];
  if (quality.blurry) reasons.push('blurry');
  if (quality.exposure === 'dark') reasons.push('too dark');
  if (quality.exposure === 'bright') reasons.push('overexposed');
  out.innerHTML = `
    <div class="note" style="margin-top:0.7rem">
      <p>This photo looks ${esc(reasons.join(' and '))}. You can retake it, or continue anyway.</p>
      <button class="btn btn-ghost" type="button" id="qualityRetake">Retake</button>
      <button class="btn btn-primary" type="button" id="qualityContinue">Continue anyway</button>
    </div>`;
  document.getElementById('qualityRetake')?.addEventListener('click', onRetake);
  document.getElementById('qualityContinue')?.addEventListener('click', onContinue);
}
```

- [x] **Step 3: Split the upload logic out and call the check first**

Replace the existing `imgEl.onchange` assignment (`public/app.js:729-745`):

```js
    imgEl.onchange = async () => {
      const file = imgEl.files[0];
      if (!file) return;
      const out = document.getElementById('ocrOut');
      out.innerHTML = '<p class="note" style="margin-top:0.7rem">Reading the photo…</p>';
      const fd = new FormData();
      fd.append('doc', data.iisNo);
      fd.append('k', String(data.k));
      fd.append('file', file, file.name);
      try {
        const res = await fetch('/api/verify-page-image', { method: 'POST', body: fd });
        renderOcrReport(out, await res.json(), file);
      } catch {
        out.innerHTML = '<p class="note" style="margin-top:0.7rem">Couldn’t reach the service.</p>';
      }
      imgEl.value = '';
    };
```

with:

```js
    const uploadPhoto = async (file) => {
      const out = document.getElementById('ocrOut');
      out.innerHTML = '<p class="note" style="margin-top:0.7rem">Reading the photo…</p>';
      const fd = new FormData();
      fd.append('doc', data.iisNo);
      fd.append('k', String(data.k));
      fd.append('file', file, file.name);
      try {
        const res = await fetch('/api/verify-page-image', { method: 'POST', body: fd });
        renderOcrReport(out, await res.json(), file);
      } catch {
        out.innerHTML = '<p class="note" style="margin-top:0.7rem">Couldn’t reach the service.</p>';
      }
      imgEl.value = '';
    };

    imgEl.onchange = async () => {
      const file = imgEl.files[0];
      if (!file) return;
      // Fail open: a decode error, an unsupported canvas, anything at all
      // here must never block the existing upload path -- this check is
      // strictly additive.
      const quality = await assessFileQuality(file).catch(() => null);
      if (quality && (quality.blurry || quality.exposure)) {
        const out = document.getElementById('ocrOut');
        renderQualityWarning(
          out,
          quality,
          () => uploadPhoto(file),
          () => { imgEl.value = ''; imgEl.click(); }
        );
        return;
      }
      await uploadPhoto(file);
    };
```

- [x] **Step 4: Manual verification against real photos (no automated browser test exists in this project for click-driven UI flows)**

Start the dev server (`cerver-ocr` launch config) and open the app in the Browser pane. Verify a page (control number + page), attach `test/fixtures/pages-special-order-383/1-genuine.jpg` via the "Attach a photo of this page" button, and confirm:
- No quality-warning prompt appears (this photo is sharp and normally exposed) — it goes straight to "Reading the photo…" exactly as before.
- Repeat with `1-altered-b.jpg` and one of the live backlit test photos already used this session — same expectation, no prompt, since none of the real fixtures/live photos this session were flagged as blurry or dark by the earlier spikes' own confidence numbers.

There is no real photo on hand that IS blurry or genuinely too dark (same gap noted throughout this session) — so a positive case (prompt actually appearing) cannot be verified against real data yet. Confirming zero false positives on every known-good real photo is what this step can responsibly check today.

- [x] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions.

- [x] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "$(cat <<'EOF'
feat(capture): warn on a blurry or poorly-exposed photo before upload

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
