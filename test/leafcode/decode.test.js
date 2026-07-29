import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../../src/leafcode/codec.js';
import { rasterize } from '../../src/leafcode/raster.js';
import { decode } from '../../src/leafcode/decode.js';

test('decode recovers payload from a clean raster', () => {
  const payload = 'CVR|R1-2026-010734|3|TQQ3-MTBT';
  assert.equal(decode(rasterize(encode(payload))), payload);
});

test('decode recovers a second distinct payload', () => {
  const payload = 'CVR|R1-1999-000001|1|AAAA-BBBB';
  assert.equal(decode(rasterize(encode(payload))), payload);
});

test('decode recovers a third distinct payload (extreme field values)', () => {
  const payload = 'CVR|R1-2020-999999|255|Z7Z7-2345';
  assert.equal(decode(rasterize(encode(payload))), payload);
});

test('decode works at px = 800', () => {
  const payload = 'CVR|R1-2026-010734|3|TQQ3-MTBT';
  const img = rasterize(encode(payload), { px: 800 });
  assert.equal(img.width, 800);
  assert.equal(decode(img), payload);
});

test('decode works at px = 1200 (larger than default)', () => {
  const payload = 'CVR|R1-2026-010734|3|TQQ3-MTBT';
  assert.equal(decode(rasterize(encode(payload), { px: 1200 })), payload);
});

test('decode does not mutate the input image', () => {
  const payload = 'CVR|R1-2026-010734|3|TQQ3-MTBT';
  const img = rasterize(encode(payload), { px: 800 });
  const before = Uint8ClampedArray.prototype.slice.call(img.data);
  const { width, height } = img;
  assert.equal(decode(img), payload);
  assert.equal(img.width, width);
  assert.equal(img.height, height);
  assert.deepEqual(img.data, before);
});

test('decode returns null for a blank white image', () => {
  const data = new Uint8ClampedArray(400 * 400 * 4).fill(255);
  assert.equal(decode({ width: 400, height: 400, data }), null);
});

test('decode returns null for an all-black image', () => {
  const data = new Uint8ClampedArray(400 * 400 * 4).fill(0);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  assert.equal(decode({ width: 400, height: 400, data }), null);
});

test('decode returns null for a random-noise image', () => {
  // Deterministic PRNG so the test cannot flake.
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const w = 300;
  const h = 300;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = (rnd() * 256) | 0;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  assert.equal(decode({ width: w, height: h, data }), null);
});

test('decode returns null for salt-and-pepper blobs that are not a LeafCode', () => {
  // Sparse random dark discs: plenty of blobs, no valid anchor triangle.
  let seed = 987;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  };
  const w = 500;
  const h = 500;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let k = 0; k < 120; k++) {
    const cx = (rnd() * w) | 0;
    const cy = (rnd() * h) | 0;
    const r = 3 + ((rnd() * 9) | 0);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const o = (y * w + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = 0;
      }
    }
  }
  assert.equal(decode({ width: w, height: h, data }), null);
});

test('decode never throws on garbage input', () => {
  const cases = [
    undefined,
    null,
    {},
    'not an image',
    42,
    { width: 10, height: 10 },
    { width: 0, height: 0, data: new Uint8ClampedArray(0) },
    { width: -5, height: 5, data: new Uint8ClampedArray(100) },
    { width: 10, height: 10, data: new Uint8ClampedArray(4) }, // truncated buffer
    { width: 1e9, height: 1e9, data: new Uint8ClampedArray(16) },
    { width: 4, height: 4, data: [0, 0, 0, 255] },
    { width: 2.5, height: 3.7, data: new Uint8ClampedArray(64) },
    { width: NaN, height: NaN, data: new Uint8ClampedArray(64) },
  ];
  for (const c of cases) {
    let out;
    assert.doesNotThrow(() => {
      out = decode(c);
    }, `threw on ${JSON.stringify(c)}`);
    assert.equal(out, null, `expected null for ${JSON.stringify(c)}`);
  }
});

test('decode tolerates a single corrupted data dot (RS error correction)', () => {
  const payload = 'CVR|R1-2026-010734|3|TQQ3-MTBT';
  const img = rasterize(encode(payload));
  // Paint a solid black square over one data node region far from the anchors,
  // flipping whatever bit lives there. RS (9 byte corrections) must absorb it.
  const { width, data } = img;
  for (let y = 300; y < 320; y++) {
    for (let x = 320; x < 340; x++) {
      const o = (y * width + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 0;
    }
  }
  assert.equal(decode(img), payload);
});
