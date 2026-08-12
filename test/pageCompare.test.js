import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWords, similarity, foldGlyphs } from '../src/pageCompare.js';

test('normalizeWords collapses whitespace and unifies punctuation variants', () => {
  const got = normalizeWords('The  "quick"\n\nbrown—fox ₱1,000');
  assert.deepEqual(got, ['the', '"quick"', 'brown-fox', '₱1,000']);
});

test('normalizeWords strips the seal footer', () => {
  const got = normalizeWords('Body text. EMB · R1-2026-010734 · p3/7 · K1 · TQQ3-MTBT');
  assert.deepEqual(got, ['body', 'text.']);
});

test('similarity is 1 for identical sequences and 0 for disjoint ones', () => {
  assert.equal(similarity(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
  assert.equal(similarity(['a', 'b'], ['x', 'y']), 0);
});

test('similarity is symmetric', () => {
  const a = normalizeWords('one two three four five');
  const b = normalizeWords('one two four five');
  assert.equal(similarity(a, b), similarity(b, a));
});

test('similarity falls below 1 whether words are dropped or invented', () => {
  const base = ['one', 'two', 'three', 'four'];
  assert.ok(similarity(base, ['one', 'two', 'three']) < 1);
  assert.ok(similarity(base, ['one', 'two', 'three', 'four', 'five']) < 1);
});

test('foldGlyphs maps letter lookalikes onto digits', () => {
  assert.equal(foldGlyphs('5O,OOO'), '50,000');
  assert.equal(foldGlyphs('l5'), '15');
  assert.equal(foldGlyphs('B2'), '82');
});

test('foldGlyphs never changes one digit into another', () => {
  assert.equal(foldGlyphs('45'), '45');
  assert.equal(foldGlyphs('500,000'), '500,000');
});
