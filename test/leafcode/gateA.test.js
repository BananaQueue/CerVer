// GATE A — the proof-of-concept's kill-switch.
//
// A pristine, undegraded LeafCode must round-trip encode -> rasterize -> decode
// with 100% success. This proves the lattice, the RS codec, the rasterizer and
// the image decoder all agree with each other. If this gate does not pass
// cleanly, the symbology is not viable and the PoC stops here (the production
// leaf-QR remains the shipping mark).
//
// Degraded/photographed input is NOT tested here — that is Gate B.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../../src/leafcode/codec.js';
import { rasterize } from '../../src/leafcode/raster.js';
import { decode } from '../../src/leafcode/decode.js';

// Spread across the payload's whole field space: different years, serials,
// page numbers (including both boundaries 1 and 255), and seals that exercise
// the base32 alphabet's letters and digits.
const payloads = [
  'CVR|R1-2026-010734|3|TQQ3-MTBT',
  'CVR|R1-2025-023099|1|BDIN-YZNT',
  'CVR|R1-2026-091234|7|QDPV-NVOZ',
  'CVR|R1-2099-000001|255|AAAA-AAAA',
  'CVR|R1-1999-999999|128|7777-2222',
  'CVR|R1-2026-055501|42|NTE2-Q72O',
];

test('Gate A: clean encode -> raster -> decode is 100% at default size', () => {
  const failures = [];
  for (const p of payloads) {
    const got = decode(rasterize(encode(p)));
    if (got !== p) failures.push(`${p} -> ${got}`);
  }
  assert.deepEqual(failures, [], `Gate A failures:\n${failures.join('\n')}`);
});

test('Gate A: clean round-trip holds across canvas sizes', () => {
  const failures = [];
  for (const px of [800, 1000, 1200, 1600]) {
    for (const p of payloads) {
      const got = decode(rasterize(encode(p), { px }));
      if (got !== p) failures.push(`px=${px} ${p} -> ${got}`);
    }
  }
  assert.deepEqual(failures, [], `Gate A size failures:\n${failures.join('\n')}`);
});
