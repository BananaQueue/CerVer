import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mul, inv } from '../../src/leafcode/gf256.js';

test('gf256 mul identity and zero', () => {
  assert.equal(mul(0, 5), 0);
  assert.equal(mul(1, 5), 5);
});
test('gf256 inverse: a * inv(a) == 1 for all a != 0', () => {
  for (let a = 1; a < 256; a++) assert.equal(mul(a, inv(a)), 1);
});
test('gf256 mul is commutative', () => {
  assert.equal(mul(0x53, 0xca), mul(0xca, 0x53));
});
