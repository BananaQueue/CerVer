import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rasterize, defaultRadii } from '../../src/leafcode/raster.js';
import { encode } from '../../src/leafcode/codec.js';
import { lattice, SPACE } from '../../src/leafcode/lattice.js';

// NOTE: the task-5 brief's own sample test used seal '7F2A-9C41', which is
// invalid under the base32 alphabet the codec enforces (excludes 0,1,8,9) --
// see test/leafcode/codec.test.js. Using the canonical valid payload agreed
// with the controller instead.
const PAYLOAD = 'CVR|R1-2026-010734|3|TQQ3-MTBT';

// Minimum centre-to-centre gap (in px, at the given canvas size) between any
// two rendered data-node discs.
function minNodeGap(px) {
  const { nodes } = lattice();
  const s = px / SPACE;
  let min = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = (nodes[i].x - nodes[j].x) * s;
      const dy = (nodes[i].y - nodes[j].y) * s;
      const d = Math.hypot(dx, dy);
      if (d < min) min = d;
    }
  }
  return min;
}

// Sample every pixel inside a small disc of radius r around (cx, cy),
// return true if ALL of them are dark (R < 128), false if none are (R ===
// 255, untouched white background). Throws if the sample is mixed, since
// that would mean the sample radius crossed a ring edge -- a bug in the
// test, not a legitimate outcome.
function sampleAllDark(img, cx, cy, r) {
  const rcx = Math.round(cx);
  const rcy = Math.round(cy);
  const ri = Math.ceil(r);
  let sawDark = false;
  let sawLight = false;
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dx = -ri; dx <= ri; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = rcx + dx;
      const y = rcy + dy;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const o = (y * img.width + x) * 4;
      if (img.data[o] < 128) sawDark = true;
      else sawLight = true;
    }
  }
  assert.ok(sawDark || sawLight, 'sample disc must cover at least one pixel');
  assert.ok(!(sawDark && sawLight), 'sample disc unexpectedly mixed dark and light pixels');
  return sawDark;
}

test('rasterize returns an image buffer with dark marks', () => {
  const img = rasterize(encode(PAYLOAD));
  assert.equal(img.data.length, img.width * img.height * 4);
  let dark = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 128) dark++;
  assert.ok(dark > 500, 'should have many dark pixels');
});

test('no two data-node discs overlap at default px', () => {
  const px = SPACE; // 1000
  const { nodeR } = defaultRadii(px);
  const gap = minNodeGap(px);
  assert.ok(
    gap > 2 * nodeR + 1,
    `expected min neighbour gap (${gap.toFixed(2)}px) to exceed disc diameter (${(2 * nodeR).toFixed(2)}px) by a positive margin`
  );
});

test('no two data-node discs overlap at px: 800 (the size Gate B uses)', () => {
  const px = 800;
  const { nodeR } = defaultRadii(px);
  const gap = minNodeGap(px);
  assert.ok(
    gap > 2 * nodeR + 1,
    `expected min neighbour gap (${gap.toFixed(2)}px) to exceed disc diameter (${(2 * nodeR).toFixed(2)}px) by a positive margin`
  );
});

test('bit fidelity at default px: every node samples back its encoded bit', () => {
  const px = SPACE;
  const s = px / px; // 1
  const bits = encode(PAYLOAD);
  const img = rasterize(bits, { px });
  const { nodes } = lattice();
  const sampleR = 2; // well inside the white interior of a hollow ring at this scale
  for (let i = 0; i < nodes.length; i++) {
    const isDark = sampleAllDark(img, nodes[i].x * s, nodes[i].y * s, sampleR);
    assert.equal(
      isDark,
      bits[i] === 1,
      `node ${i} (bit ${bits[i]}) sampled as ${isDark ? 'DARK' : 'LIGHT'}`
    );
  }
});

test('bit fidelity at px: 800: every node samples back its encoded bit', () => {
  const px = 800;
  const s = px / SPACE;
  const bits = encode(PAYLOAD);
  const img = rasterize(bits, { px });
  const { nodes } = lattice();
  const sampleR = 2;
  for (let i = 0; i < nodes.length; i++) {
    const isDark = sampleAllDark(img, nodes[i].x * s, nodes[i].y * s, sampleR);
    assert.equal(
      isDark,
      bits[i] === 1,
      `node ${i} (bit ${bits[i]}) sampled as ${isDark ? 'DARK' : 'LIGHT'}`
    );
  }
});

test('anchors are drawn larger than data nodes', () => {
  const { nodeR, anchorR } = defaultRadii(SPACE);
  assert.ok(anchorR > nodeR, `anchorR (${anchorR}) should exceed nodeR (${nodeR})`);

  // Empirical check: measure the actual rendered dark-pixel area of one
  // anchor vs. one solid data node, in a local box just big enough to
  // contain the mark's own radius but too small to reach a neighbour.
  // Anchors clear neighbouring marks by >= 40 canonical units and data
  // nodes by >= 24 (lattice.js invariants), both comfortably bigger than
  // the box radii used here.
  const bits = new Uint8Array(256).fill(1); // every data node solid, for a clean area comparison
  const img = rasterize(bits, { px: SPACE });
  const { nodes, anchors } = lattice();

  const darkAreaAround = (cx, cy, boxR) => {
    let count = 0;
    const rcx = Math.round(cx);
    const rcy = Math.round(cy);
    for (let dy = -boxR; dy <= boxR; dy++) {
      for (let dx = -boxR; dx <= boxR; dx++) {
        const x = rcx + dx;
        const y = rcy + dy;
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
        const o = (y * img.width + x) * 4;
        if (img.data[o] < 128) count++;
      }
    }
    return count;
  };

  const anchorArea = darkAreaAround(anchors[0].x, anchors[0].y, Math.round(anchorR) + 1);
  const nodeArea = darkAreaAround(nodes[0].x, nodes[0].y, Math.round(nodeR) + 1);
  assert.ok(anchorArea > nodeArea, `anchor area (${anchorArea}px) should exceed node area (${nodeArea}px)`);
});
