import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentConfidence } from '../src/ocr.js';

// See docs/superpowers/specs/2026-08-27-content-word-confidence-design.md.
// words carry confidence already normalized to 0..1 (the shape recognize()
// builds them in) -- not Tesseract's raw 0..100.

test('contentConfidence averages only content-bearing words, not the punctuation Tesseract scores near zero', () => {
  const words = [
    { text: 'Republic', confidence: 0.95 },
    { text: '"', confidence: 0.01 },
    { text: 'of', confidence: 0.9 },
    { text: '-', confidence: 0.0 },
    { text: 'the', confidence: 0.92 },
    { text: ':', confidence: 0.02 },
    { text: 'Philippines', confidence: 0.93 },
  ];
  // Mean of the four content words only: (0.95+0.9+0.92+0.93)/4
  const expected = (0.95 + 0.9 + 0.92 + 0.93) / 4;
  assert.equal(contentConfidence(words, { confidence: 62 }), expected);
});

test('a single character does not count as a content word, but a two-character one does', () => {
  const words = [
    { text: 'a', confidence: 0.99 }, // 1 char -- excluded
    { text: 'of', confidence: 0.4 }, // 2 chars -- included
  ];
  assert.equal(contentConfidence(words, { confidence: 50 }), 0.4);
});

test('an all-punctuation word list falls back to the page-level confidence, not zero or a division error', () => {
  const words = [
    { text: '"', confidence: 0.01 },
    { text: '-', confidence: 0.0 },
    { text: ':', confidence: 0.02 },
  ];
  assert.equal(contentConfidence(words, { confidence: 55 }), 0.55);
});

test('an empty word list falls back to the page-level confidence', () => {
  assert.equal(contentConfidence([], { confidence: 70 }), 0.7);
});

test('the fallback clamps an out-of-range or non-finite page-level confidence the same way recognize() always has', () => {
  assert.equal(contentConfidence([], { confidence: -5 }), 0);
  assert.equal(contentConfidence([], { confidence: 150 }), 1);
  assert.equal(contentConfidence([], { confidence: undefined }), 0);
});
