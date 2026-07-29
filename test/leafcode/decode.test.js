import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../../src/leafcode/codec.js';
import { rasterize, defaultRadii } from '../../src/leafcode/raster.js';
import { decode } from '../../src/leafcode/decode.js';
import { lattice } from '../../src/leafcode/lattice.js';

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

// Paint a filled disc of the OPPOSITE colour over an entire node's footprint
// at real lattice coordinates, so the node's sampled bit is genuinely
// flipped (not just nudged): a solid (bit=1) node is painted white (erased
// to background, reading back as hollow/absent), a hollow (bit=0) node is
// painted solid dark (reading back as solid). `r` should cover the node's
// full radius so the flip is unambiguous under decode.js's sampling.
function invertNodeMark(img, cx, cy, r, wasSolid) {
  const { width, height, data } = img;
  const rcx = Math.round(cx);
  const rcy = Math.round(cy);
  const ri = Math.ceil(r);
  const v = wasSolid ? 255 : 0; // erase a solid mark to white; fill a hollow mark to black
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dx = -ri; dx <= ri; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = rcx + dx;
      const y = rcy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const o = (y * width + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
}

// Corrupt every node in the given RS byte-groups (byteIdx*8 .. byteIdx*8+7),
// inverting each node's actual bit so the byte value is guaranteed to
// change (an 8-bit value XORed with all-ones can never equal itself).
// Returns the number of nodes painted.
function corruptByteGroups(img, nodes, bits, nodeR, byteIndices) {
  let painted = 0;
  for (const byteIdx of byteIndices) {
    for (let b = 0; b < 8; b++) {
      const i = byteIdx * 8 + b;
      const n = nodes[i];
      invertNodeMark(img, n.x, n.y, nodeR + 1, bits[i] === 1);
      painted++;
    }
  }
  return painted;
}

test('decode tolerates several corrupted data bytes (RS error correction)', () => {
  const payload = 'CVR|R1-2026-010734|3|TQQ3-MTBT';
  const bits = encode(payload);
  const clean = rasterize(bits);
  const cleanSnapshot = Uint8ClampedArray.prototype.slice.call(clean.data);
  const img = rasterize(bits); // separate instance to corrupt

  const { nodes } = lattice();
  const { nodeR } = defaultRadii(img.width);

  // Corrupt 3 whole RS byte-groups (24 of 256 nodes) -- comfortably inside
  // RS's capacity of 9 corrected byte errors out of 32.
  const painted = corruptByteGroups(img, nodes, bits, nodeR, [0, 10, 20]);
  assert.equal(painted, 24);

  // Prove the corruption is real: the damaged image must differ from a
  // clean render of the same payload, by more than a handful of pixels, so
  // this test can never silently regress into a no-op again.
  let diffPixels = 0;
  for (let o = 0; o < img.data.length; o += 4) {
    if (img.data[o] !== cleanSnapshot[o]) diffPixels++;
  }
  assert.ok(diffPixels > 100, `expected substantial pixel diff from corruption, got ${diffPixels}`);
  assert.notDeepEqual(img.data, cleanSnapshot);

  assert.equal(decode(img), payload);
});

test('decode returns null (never a wrong payload) when corruption exceeds RS capacity', () => {
  const payload = 'CVR|R1-2026-010734|3|TQQ3-MTBT';
  const bits = encode(payload);
  const img = rasterize(bits);

  const { nodes } = lattice();
  const { nodeR } = defaultRadii(img.width);

  // Corrupt 12 whole RS byte-groups (96 of 256 nodes) -- well beyond the
  // 9-byte correction capacity out of 32. A verification system must fail
  // CLOSED here: returning null is correct, returning some other plausible
  // payload would be the worst possible failure mode.
  const painted = corruptByteGroups(img, nodes, bits, nodeR, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(painted, 96);

  const result = decode(img);
  assert.notEqual(result, payload);
  assert.equal(result, null);
});
