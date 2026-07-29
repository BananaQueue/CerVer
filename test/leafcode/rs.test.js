import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rsEncode, rsDecode } from '../../src/leafcode/rs.js';

test('rs round-trips with no errors', () => {
  const data = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  const code = rsEncode(data, 19);
  assert.equal(code.length, 32);
  assert.deepEqual([...rsDecode(code, 19)], [...data]);
});
test('rs corrects up to 9 byte errors', () => {
  const data = Uint8Array.from(Array.from({ length: 13 }, (_, i) => i * 7 + 1));
  const code = rsEncode(data, 19);
  for (const p of [0, 3, 5, 9, 12, 17, 20, 25, 31]) code[p] ^= 0xff;
  assert.deepEqual([...rsDecode(code, 19)], [...data]);
});
test('rs returns null past correction capacity', () => {
  const data = Uint8Array.from(Array.from({ length: 13 }, (_, i) => i + 1));
  const code = rsEncode(data, 19);
  for (let p = 0; p < 12; p++) code[p] ^= 0xa5; // 12 > 9 errors
  assert.equal(rsDecode(code, 19), null);
});
