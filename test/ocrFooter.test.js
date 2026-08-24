import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripOcrFooter } from '../src/ocrFooter.js';

// bbox y-coordinates grow downward (image/screen convention, same as
// Tesseract's own bbox). A word is 10px tall by default here. x-position
// keeps words distinct and in left-to-right reading order.
//
// Deterministic small y-JITTER is applied per word (a fixed repeating
// offset pattern, not random -- reproducible, but never identical between
// consecutive words). Real OCR words on the same visual line essentially
// never share an exact y-center; a fixture that gives every word on a line
// the identical y hides exactly the class of bug this jitter caught during
// implementation (clustering silently scrambled reading order, and nothing
// here noticed until a real photo, at which point removal was a silent
// no-op). Y-JITTER is intentionally smaller than half the word height, so
// it never breaks clustering itself -- only reading order within a cluster.
const Y_JITTER = [0, 2, -1, 1, -2, 1, -1, 2];
let nextX = 0;
let jitterIndex = 0;
const wordAt = (text, y, opts = {}) => {
  const x0 = opts.x0 ?? nextX;
  nextX = x0 + 20;
  const jitter = Y_JITTER[jitterIndex % Y_JITTER.length];
  jitterIndex++;
  const jitteredY = y + jitter;
  return {
    text,
    confidence: opts.confidence ?? 0.8,
    bbox: { x0, y0: jitteredY, x1: x0 + 15, y1: jitteredY + (opts.height ?? 10) },
  };
};
const resetX = () => { nextX = 0; jitterIndex = 0; };

test('removes a garbled footer line that still carries a misread reference', () => {
  resetX();
  const words = [
    wordAt('Control', 0), wordAt('No.', 0), wordAt('R1-2026-010734', 0), wordAt('is', 0), wordAt('confirmed.', 0),
  ];
  resetX();
  // The actual OCR reading of a real garbled footer, pulled from
  // test/fixtures/pages/2-genuine-c.jpg during 2026-08-24 calibration.
  const footerWords = ['4', '7', 'Be', 'R1-2026-010794', '=', '27>', '-', 'tea']
    .map((t) => wordAt(t, 500));
  const all = [...words, ...footerWords];
  const text = all.map((w) => w.text).join(' ');

  const result = stripOcrFooter(text, all);

  assert.ok(!result.includes('R1-2026-010794'), 'the garbled footer reference should be removed');
  assert.ok(result.includes('R1-2026-010734'), 'the real body reference must survive');
  assert.ok(result.includes('confirmed.'), 'body text must survive');
});

test('the gate refuses a last line that also states a value (money/date/duration)', () => {
  resetX();
  const words = [wordAt('Total', 0), wordAt('due', 0)];
  resetX();
  const lastLine = ['Total', 'P50,000.00', 'per', 'R1-2026-010734'].map((t) => wordAt(t, 500));
  const all = [...words, ...lastLine];
  const text = all.map((w) => w.text).join(' ');

  const result = stripOcrFooter(text, all);

  assert.equal(result, text, 'a line carrying a money value must never be removed, even if it also looks reference-shaped');
});

test('leaves a genuine body reference untouched when the bottommost line is not footer-shaped', () => {
  resetX();
  const bodyWithReference = ['Per', 'R1-2026-010734', 'the', 'terms', 'apply.'].map((t) => wordAt(t, 0));
  resetX();
  const plainLastLine = ['Page', '2', 'of', '3'].map((t) => wordAt(t, 500));
  const all = [...bodyWithReference, ...plainLastLine];
  const text = all.map((w) => w.text).join(' ');

  const result = stripOcrFooter(text, all);

  assert.equal(result, text, 'nothing should be removed when the bottommost line has no reference/citation shape');
});

test('an empty or missing words array leaves the text completely unchanged', () => {
  assert.equal(stripOcrFooter('some ordinary text', []), 'some ordinary text');
  assert.equal(stripOcrFooter('some ordinary text', undefined), 'some ordinary text');
});

test('the accepted blind spot: a tampered reference placed at the footer position is not caught by this mechanism', () => {
  resetX();
  const words = [wordAt('Control', 0), wordAt('No.', 0), wordAt('R1-2026-010734', 0)];
  resetX();
  // A footer-shaped last line (reference only, nothing else) whose reference
  // digit was deliberately changed -- indistinguishable, by shape alone, from
  // an innocently misread one. This is the boundary the design spec (§2, §6)
  // names directly rather than leaving implicit.
  const tamperedFooter = ['EMB', 'R1-2026-010799', 'ABCD-EFGH'].map((t) => wordAt(t, 500));
  const all = [...words, ...tamperedFooter];
  const text = all.map((w) => w.text).join(' ');

  const result = stripOcrFooter(text, all);

  assert.ok(!result.includes('R1-2026-010799'), 'documents the known limit: this value is excluded, not flagged');
});
