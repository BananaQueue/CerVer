import test from 'node:test';
import assert from 'node:assert/strict';
import { coverSourceRect } from '../public/coverRect.js';

// The preview element shows the camera through `object-fit: cover`: the frame is
// scaled to fill the box and the overflow is cropped. The decoder must be handed
// exactly that region, or the viewfinder lies about where the mark is.

test('a frame matching the box aspect is used whole', () => {
  assert.deepEqual(coverSourceRect(640, 480, 640, 480), { sx: 0, sy: 0, sw: 640, sh: 480 });
});

test('aspect, not size, decides the crop', () => {
  // Same 4:3 shape at a different scale is still used whole.
  assert.deepEqual(coverSourceRect(1600, 1200, 320, 240), { sx: 0, sy: 0, sw: 1600, sh: 1200 });
});

test('a frame wider than the box is cropped left and right', () => {
  // 16:9 into 4:3: full height, width trimmed to 900 * 4/3 = 1200, centred.
  assert.deepEqual(coverSourceRect(1600, 900, 400, 300), { sx: 200, sy: 0, sw: 1200, sh: 900 });
});

test('a portrait phone frame is cropped top and bottom', () => {
  // The real case: 1080x1920 into the 4:3 viewport. Full width, height trimmed
  // to 1080 * 3/4 = 810, centred — NOT the 1080-tall centre square the capture
  // used to take, which reaches well outside what the preview showed.
  assert.deepEqual(coverSourceRect(1080, 1920, 400, 300), { sx: 0, sy: 555, sw: 1080, sh: 810 });
});

test('the cropped region always matches the box aspect ratio', () => {
  for (const [vw, vh] of [[1080, 1920], [1600, 900], [640, 480], [1280, 720], [480, 640]]) {
    const r = coverSourceRect(vw, vh, 400, 300);
    assert.ok(Math.abs(r.sw / r.sh - 4 / 3) < 1e-9, `${vw}x${vh} -> ${r.sw}x${r.sh}`);
  }
});

test('the cropped region stays inside the frame', () => {
  for (const [vw, vh] of [[1080, 1920], [1600, 900], [1280, 720], [480, 640]]) {
    const r = coverSourceRect(vw, vh, 400, 300);
    assert.ok(r.sx >= 0 && r.sy >= 0, 'origin inside frame');
    assert.ok(r.sx + r.sw <= vw && r.sy + r.sh <= vh, 'extent inside frame');
  }
});

test('a degenerate box falls back to the whole frame', () => {
  // Before layout settles, clientWidth/clientHeight can be 0. Better to decode
  // the whole frame than to divide by zero and hand the decoder nothing.
  assert.deepEqual(coverSourceRect(640, 480, 0, 0), { sx: 0, sy: 0, sw: 640, sh: 480 });
});
