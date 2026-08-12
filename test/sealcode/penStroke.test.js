import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, inspect } from '../../src/sealcode/decode.js';
import { rasterize } from '../../src/sealcode/encode.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// A real phone capture of a sealed page that someone has written across with a
// ballpen: the mark is whole, well lit and at 10.8 px per tile, and one stroke
// crosses into the disc from the lower left and out past its edge.
//
// Stored as gzipped grey rather than PNG - the decoder reduces to grey with these
// same weights, so nothing is lost, and it needs no image library. Verified to
// decode identically to the PNG it was made from.
function capture(name) {
  const raw = gunzipSync(readFileSync(path.join(here, '..', 'fixtures', name)));
  const w = raw.readUInt16LE(0), h = raw.readUInt16LE(2);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = raw[4 + i], o = i * 4;
    data[o] = data[o + 1] = data[o + 2] = v;
    data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}

// Confirmed against the footer printed on the same page: "p2/2 · K1 · 36DK-GKFW".
const EXPECTED = 'CVR|R1-2026-001024|2|36DK-GKFW';

test('reads a page written across with a ballpen', () => {
  const img = capture('pen-stroke-capture.gray.gz');
  const got = inspect(img);
  assert.equal(
    got.payload,
    EXPECTED,
    `score ${(got.score * 100).toFixed(0)}% at ${got.deg}deg, pitch ${got.pitch.toFixed(1)}`
  );
});

test('a stroke does not turn into a different payload', () => {
  // The danger with retrying more boxes is manufacturing a plausible wrong read.
  // Every threshold that recovers this frame must agree on what it says.
  assert.equal(decode(capture('pen-stroke-capture.gray.gz')), EXPECTED);
});

test('an undamaged mark still reads', () => {
  // The fallback must not disturb the path that already worked.
  const payload = 'CVR|R1-2026-010734|3|PP64-QXA6';
  assert.equal(decode(rasterize(payload, { px: 44 * 12, quiet: 0.2 })), payload);
});

// Synthetic strokes, to cover angles the one real capture does not. These are a
// supplement to the fixture above, not a substitute: strokes drawn on a clean
// rasterisation lack the blur and ink spread that decide the real cases, and
// they once suggested this was insensitive to threshold when it is not.
function withStroke(payload, [ax, ay, bx, by], tiles = 1) {
  const TILE = 14;
  const img = rasterize(payload, { px: 44 * TILE, quiet: 0.25 });
  const S = img.width, r = (tiles * TILE) / 2;
  const [x0, y0, x1, y1] = [ax * S, ay * S, bx * S, by * S];
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= n; i++) {
    const t = i / n, cx = x0 + (x1 - x0) * t, cy = y0 + (y1 - y0) * t;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x >= S || y >= img.height) continue;
        const o = (y * S + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 20;
      }
    }
  }
  return img;
}

for (const [name, line] of [
  ['a stub protruding to the left', [0.06, 0.5, 0.28, 0.5]],
  ['a stub protruding below', [0.5, 0.75, 0.5, 0.96]],
  ['a diagonal entering from the lower left', [0.04, 0.96, 0.7, 0.3]],
  ['a diagonal entering from the upper left', [0.04, 0.24, 0.7, 0.9]],
  ['a stroke clean across, out both sides', [0.02, 0.6, 0.98, 0.42]],
]) {
  test(`reads through ${name}`, () => {
    const payload = 'CVR|R1-2026-010734|3|PP64-QXA6';
    const got = inspect(withStroke(payload, line));
    assert.equal(got.payload, payload, `score ${(got.score * 100).toFixed(0)}% at ${got.deg}deg`);
  });
}

test('blank paper still reports no seal', () => {
  const w = 500, h = 400;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  // A few strokes and specks, but no mark anywhere.
  for (let x = 40; x < 460; x++) {
    for (let d = 0; d < 3; d++) {
      const o = ((120 + d + ((x * 7) % 5)) * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 20;
    }
  }
  assert.equal(decode({ width: w, height: h, data }), null);
});
