import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize,
  stripFooter,
  digestPage,
  computeSeal,
  formatFooter,
  parseFooter,
  sealsEqual,
} from '../src/sealCode.js';

test('canonicalize collapses whitespace', () => {
  assert.equal(canonicalize('  a\n\t b   c '), 'a b c');
});

test('formatFooter and parseFooter round-trip', () => {
  const f = { iisNo: 'R1-2026-010734', k: 3, n: 7, kid: '1', seal: '7F2A-9C41' };
  const line = formatFooter(f);
  assert.match(line, /EMB · R1-2026-010734 · p3\/7 · K1 · 7F2A-9C41/);
  assert.deepEqual(parseFooter(line), f);
});

test('parseFooter tolerates extraction spacing and returns null when absent', () => {
  const spaced = 'body text  EMB · R1-2026-010734   ·   p3/7   ·   K1   ·   7F2A-9C41';
  assert.equal(parseFooter(spaced).k, 3);
  assert.equal(parseFooter('just body text'), null);
});

test('stripFooter removes the seal line before hashing', () => {
  const withFooter = 'Real body content. EMB · R1-2026-010734 · p3/7 · K1 · 7F2A-9C41';
  assert.equal(stripFooter(withFooter), 'Real body content.');
});

test('digest is stable across whitespace but changes with content', () => {
  assert.equal(digestPage('hello   world'), digestPage('hello world'));
  assert.notEqual(digestPage('hello world'), digestPage('hello worlds'));
});

test('computeSeal is deterministic and changes when any bound field changes', () => {
  const base = { iisNo: 'R1-2026-010734', k: 3, n: 7, digest: 'abc' };
  const s = computeSeal('secret', base);
  assert.match(s, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  assert.equal(s, computeSeal('secret', base));
  assert.notEqual(s, computeSeal('secret', { ...base, digest: 'abd' }));
  assert.notEqual(s, computeSeal('secret', { ...base, k: 4 }));
  assert.notEqual(s, computeSeal('secret', { ...base, n: 8 }));
  assert.notEqual(s, computeSeal('other', base));
});

test('sealsEqual is length-safe', () => {
  assert.equal(sealsEqual('7F2A-9C41', '7F2A-9C41'), true);
  assert.equal(sealsEqual('7F2A-9C41', '7F2A-9C42'), false);
  assert.equal(sealsEqual('7F2A-9C41', 'short'), false);
});
