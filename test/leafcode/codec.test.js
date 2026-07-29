import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, bitsToPayload } from '../../src/leafcode/codec.js';

// NOTE: the task brief's sample payload used seal '7F2A-9C41', but that seal
// is invalid under the base32 alphabet 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
// (excludes 0,1,8,9) and the packPayload regex [A-Z2-7]{4}-[A-Z2-7]{4}.
// Replaced with a valid seal, 'TQQ3-MTBT', per controller correction.
const PAYLOAD = 'CVR|R1-2026-010734|3|TQQ3-MTBT';

test('encode produces 256 bits (0/1)', () => {
  const bits = encode(PAYLOAD);
  assert.equal(bits.length, 256);
  assert.ok([...bits].every((b) => b === 0 || b === 1));
});
test('encode → bitsToPayload round-trips', () => {
  assert.equal(bitsToPayload(encode(PAYLOAD)), PAYLOAD);
});
test('bitsToPayload recovers from flipped bits (RS)', () => {
  const bits = encode(PAYLOAD);
  for (const i of [0, 8, 40, 100, 130, 170, 200, 240]) bits[i] ^= 1;
  assert.equal(bitsToPayload(bits), PAYLOAD);
});
test('non-leafcode bits return null', () => {
  const bits = new Uint8Array(256); // all zero
  assert.equal(bitsToPayload(bits), null);
});

// Additional sanity checks beyond the brief's cases.
test('round-trips with a different serial, page, and seal', () => {
  const payload = 'CVR|R1-2025-000001|1|AAAA-2222';
  assert.equal(bitsToPayload(encode(payload)), payload);
});
test('round-trips with max 3-digit page and high serial', () => {
  const payload = 'CVR|R1-2099-999999|255|ZZZZ-7777';
  assert.equal(bitsToPayload(encode(payload)), payload);
});
test('encode rejects invalid payload (bad seal characters, digits 0/1/8/9)', () => {
  assert.throws(() => encode('CVR|R1-2026-010734|3|7F2A-9C41'));
});
test('encode rejects malformed payload string outright', () => {
  assert.throws(() => encode('not a valid payload'));
});
test('bitsToPayload returns null for random noise bits', () => {
  const bits = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bits[i] = (i * 73 + 5) % 2;
  assert.equal(bitsToPayload(bits), null);
});

// Regression: page is packed into a single byte (page & 0xff), but the
// payload regex allowed \d{1,3} (0-999). Out-of-range pages must be
// rejected at encode time, not silently truncated/wrapped into a
// different, wrong page number.
test('encode rejects page 256 (out of single-byte range)', () => {
  assert.throws(() => encode('CVR|R1-2026-010734|256|TQQ3-MTBT'));
});
test('encode rejects page 500 (previously silently truncated to 244)', () => {
  assert.throws(() => encode('CVR|R1-2026-010734|500|TQQ3-MTBT'));
});
test('encode rejects page 0 (not a meaningful page number)', () => {
  assert.throws(() => encode('CVR|R1-2026-010734|0|TQQ3-MTBT'));
});
test('encode succeeds and round-trips for boundary page 1', () => {
  const payload = 'CVR|R1-2026-010734|1|TQQ3-MTBT';
  assert.equal(bitsToPayload(encode(payload)), payload);
});
test('encode succeeds and round-trips for boundary page 255', () => {
  const payload = 'CVR|R1-2026-010734|255|TQQ3-MTBT';
  assert.equal(bitsToPayload(encode(payload)), payload);
});
