import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalizer.js';

test('bare IIS number', () => {
  const r = normalize('R1-2025-028799');
  assert.equal(r.kind, 'iis_no');
  assert.equal(r.canonicalId, 'R1-2025-028799');
  assert.equal(r.lookupKey, 'R1-2025-028799');
});

test('EMBR1 prefixed travel-order number canonicalizes to R1', () => {
  const r = normalize('EMBR1-2025-030436');
  assert.equal(r.kind, 'iis_no');
  assert.equal(r.canonicalId, 'R1-2025-030436');
});

test('lowercase and whitespace tolerated', () => {
  const r = normalize('  r1-2026-009186 \n');
  assert.equal(r.kind, 'iis_no');
  assert.equal(r.canonicalId, 'R1-2026-009186');
});

test('hash token treated as token', () => {
  const t = '13081688c1eb0a6ab8-69-2025-09-16-69-2025-09-30';
  const r = normalize(t);
  assert.equal(r.kind, 'token');
  assert.equal(r.canonicalId, t);
});

test('preview2 URL extracts token', () => {
  const r = normalize(
    'https://iis.emb.gov.ph/embis/dar/preview2/13081688c1eb0a6ab8-69-2025-09-16-69-2025-09-30'
  );
  assert.equal(r.kind, 'token');
  assert.equal(r.canonicalId, '13081688c1eb0a6ab8-69-2025-09-16-69-2025-09-30');
});

test('URL containing a bare IIS number resolves to iis_no', () => {
  const r = normalize('https://iis.emb.gov.ph/embis/x/R1-2025-028799');
  assert.equal(r.kind, 'iis_no');
  assert.equal(r.canonicalId, 'R1-2025-028799');
});

test('empty input is unknown', () => {
  const r = normalize('   ');
  assert.equal(r.kind, 'unknown');
});
