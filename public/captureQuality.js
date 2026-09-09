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
