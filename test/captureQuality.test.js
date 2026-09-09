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
