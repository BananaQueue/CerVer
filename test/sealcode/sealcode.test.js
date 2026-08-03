import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N, GRID, CARRIERS, FIXED } from '../../src/sealcode/baseline.js';
import { tilesFor, payloadFromTiles, rasterize, renderSvg, baselineTiles } from '../../src/sealcode/encode.js';
import { decode } from '../../src/sealcode/decode.js';

const P1 = 'CVR|R1-2026-010734|1|PP64-QXA6';
const P2 = 'CVR|R1-2025-023099|7|BDIN-YZNT';
const P3 = 'CVR|R1-2099-000001|255|AAAA-AAAA';

function rotate(img, deg) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  const t = (deg * Math.PI) / 180, co = Math.cos(t), si = Math.sin(t);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.round(co * (x - cx) + si * (y - cy) + cx);
      const sy = Math.round(-si * (x - cx) + co * (y - cy) + cy);
      const o = (y * w + x) * 4;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) { out[o] = out[o+1] = out[o+2] = 255; out[o+3] = 255; continue; }
      const so = (sy * w + sx) * 4;
      out[o] = data[so]; out[o+1] = data[so+1]; out[o+2] = data[so+2]; out[o+3] = 255;
    }
  return { width: w, height: h, data: out };
}
const solid = (w, h, fn) => {
  const a = new Uint8ClampedArray(w * h * 4).fill(255);
  if (fn) fn(a, w, h);
  return { width: w, height: h, data: a };
};

test('baseline is the frozen artwork and carriers exclude every edge', () => {
  assert.equal(N, 44);
  assert.equal(GRID.length, N);
  assert.ok(CARRIERS.length >= 184, `need >=184 carriers, have ${CARRIERS.length}`);
  // no carrier may touch a blank tile — that is what keeps the seal's outline,
  // the tree and the band edges identical on every document
  const at = (r, c) => (r < 0 || c < 0 || r >= N || c >= N ? 0 : GRID[r][c] === '1' ? 1 : 0);
  for (const [r, c] of CARRIERS) {
    assert.equal(at(r, c), 1, `carrier ${r},${c} must be inked`);
    assert.ok(at(r-1,c) && at(r+1,c) && at(r,c-1) && at(r,c+1), `carrier ${r},${c} touches a blank tile`);
  }
  assert.equal(CARRIERS.length + FIXED.length, N * N);
});

test('encoding only ever clears tiles, never adds ink', () => {
  const base = baselineTiles();
  const tiles = tilesFor(P1);
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++)
      if (!base[r][c]) assert.equal(tiles[r][c], 0, `tile ${r},${c} gained ink`);
});

test('tiles round-trip back to the payload', () => {
  for (const p of [P1, P2, P3]) assert.equal(payloadFromTiles(tilesFor(p)), p);
});

test('different payloads produce different marks', () => {
  assert.notDeepEqual(tilesFor(P1), tilesFor(P2));
});

test('decodes from a rendered image across sizes', () => {
  const fails = [];
  for (const px of [880, 704, 528, 440, 352, 264, 220, 176, 132, 110])
    if (decode(rasterize(P1, { px })) !== P1) fails.push(px);
  assert.deepEqual(fails, [], `failed at ${fails.join(', ')} px`);
});

test('decodes every payload', () => {
  for (const p of [P1, P2, P3]) assert.equal(decode(rasterize(p, { px: 440 })), p);
});

test('decodes at any rotation', () => {
  const img = rasterize(P1, { px: 520 });
  const fails = [];
  for (const d of [0, 5, 15, 30, 45, 60, 90, 135, 180, 225, 270, 315])
    if (decode(rotate(img, d)) !== P1) fails.push(d);
  assert.deepEqual(fails, [], `failed at ${fails.join(', ')} deg`);
});

test('rejects things that are not an EMB seal', () => {
  assert.equal(decode(solid(300, 300)), null, 'blank page');
  assert.equal(decode(solid(300, 300, (a) => {
    for (let i = 0; i < a.length; i += 4) { const v = (i * 2654435761) % 255; a[i] = a[i+1] = a[i+2] = v; }
  })), null, 'noise');
  assert.equal(decode(solid(300, 300, (a, w) => {
    for (let y = 80; y < 220; y++) for (let x = 80; x < 220; x++) { const o = (y*w+x)*4; a[o]=a[o+1]=a[o+2]=0; }
  })), null, 'solid square');
});

test('never throws on hostile input', () => {
  for (const bad of [null, undefined, {}, { width: 0, height: 0, data: new Uint8ClampedArray(0) },
                     { width: 10, height: 10, data: new Uint8ClampedArray(4) }])
    assert.equal(decode(bad), null);
});

test('renderSvg produces a drawable mark', () => {
  const svg = renderSvg(P1, { px: 512 });
  assert.match(svg, /^<svg/);
  assert.ok((svg.match(/<rect/g) || []).length > 300);
});

test('decodes through real browser rasterisation, not just the pixel double', async () => {
  // The pure-JS rasterizer makes hard black/white edges. Real rendering
  // antialiases and lands tile edges on fractional pixels, so the SVG is
  // rasterised in Chrome and decoded from those pixels — the path an actual
  // scan takes.
  const { chromium } = await import('playwright');
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const pg = await b.newPage();
    const svg = renderSvg(P1, { px: 1000 });
    const fails = [];
    for (const px of [140, 200, 280, 420]) {
      const out = await pg.evaluate(async ({ svg, px }) => {
        const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
        const im = new Image(); im.src = url; await im.decode();
        const pad = Math.round(px * 0.12), W = px + pad * 2;
        const cv = document.createElement('canvas'); cv.width = W; cv.height = W;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, W);
        cx.drawImage(im, pad, pad, px, px);
        const d = cx.getImageData(0, 0, W, W);
        return { width: d.width, height: d.height, data: Array.from(d.data) };
      }, { svg, px });
      const got = decode({ width: out.width, height: out.height, data: new Uint8ClampedArray(out.data) });
      if (got !== P1) fails.push(px);
    }
    assert.deepEqual(fails, [], `browser-rasterised decode failed at ${fails.join(', ')} px`);
  } finally {
    await b.close();
  }
});
