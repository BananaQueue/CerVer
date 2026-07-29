// GATE B — synthetic degradation measurement harness.
//
// Gate A (test/leafcode/gateA.test.js) already proved that a pristine
// encode -> rasterize -> decode round-trip is 100% reliable. That says
// nothing about a photographed or otherwise imperfect capture. Gate B feeds
// the same clean rasterizations through synthetic degradations (blur,
// rotation, resolution loss, noise, and combinations of those) and measures
// the decode success rate per condition.
//
// This is a MEASUREMENT, not a pass/fail gate: harsh conditions are
// EXPECTED to decode poorly, and that is not a test failure -- it is the
// data point the whole exercise exists to produce. The one genuine
// assertion here is that the undegraded control stays at 100%, which guards
// against the harness accidentally measuring nothing (e.g. a broken
// condition function that silently no-ops every case, or a payload list
// that was never actually valid).
//
// Do not read a "weak" row here as a decoder bug to fix -- decode.js,
// raster.js, codec.js, lattice.js, rs.js and gf256.js are frozen for this
// task. The results table is the deliverable; see task-9-report.md for the
// GO/NO-GO reading.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../../src/leafcode/codec.js';
import { rasterize } from '../../src/leafcode/raster.js';
import { decode } from '../../src/leafcode/decode.js';
import { blur, rotate, scaleDown, noise } from '../../src/leafcode/degrade.js';

// Five distinct valid payloads spanning different years, serials, page
// numbers (including the low and high boundary, 1 and 255) and seals that
// exercise letters and base32 digits (2-7 only; no 0/1/8/9).
const payloads = [
  'CVR|R1-2026-010734|3|TQQ3-MTBT',
  'CVR|R1-2025-023099|1|BDIN-YZNT',
  'CVR|R1-2026-091234|7|QDPV-NVOZ',
  'CVR|R1-2099-000001|255|AAAA-AAAA',
  'CVR|R1-2026-055501|42|NTE2-Q72O',
];

const PX = 1000; // a real photo would be at least this resolution

// Each condition is a function image -> image. Conditions are applied to a
// fresh clean rasterization of each payload (never to another condition's
// output), except the explicitly COMBINED conditions at the bottom, which
// chain several single degradations to approximate a real capture (a photo
// is rarely blurred OR rotated OR noisy -- usually some of each at once).
const conditions = {
  'control (none)': (img) => img,

  'blur r1': (img) => blur(img, 1),
  'blur r2': (img) => blur(img, 2),
  'blur r3': (img) => blur(img, 3),
  'blur r4': (img) => blur(img, 4),

  'rotate 5deg': (img) => rotate(img, 5),
  'rotate 15deg': (img) => rotate(img, 15),
  'rotate 30deg': (img) => rotate(img, 30),
  'rotate 45deg': (img) => rotate(img, 45),
  'rotate 90deg': (img) => rotate(img, 90),

  'scale /1.5': (img) => scaleDown(img, 1.5),
  'scale /2': (img) => scaleDown(img, 2),
  'scale /3': (img) => scaleDown(img, 3),
  'scale /4': (img) => scaleDown(img, 4),

  'noise 20': (img) => noise(img, 20, 7),
  'noise 40': (img) => noise(img, 40, 7),
  'noise 60': (img) => noise(img, 60, 7),
  'noise 80': (img) => noise(img, 80, 7),

  // Combined: approximations of a real photographed capture, which is
  // never degraded along just one axis.
  'combo: blur1+rotate5+noise20 (light photo)': (img) =>
    noise(rotate(blur(img, 1), 5), 20, 11),
  'combo: blur2+rotate15+noise40 (typical photo)': (img) =>
    noise(rotate(blur(img, 2), 15), 40, 13),
  'combo: blur2+rotate30+scale2+noise40 (poor photo)': (img) =>
    noise(scaleDown(rotate(blur(img, 2), 30), 2), 40, 17),
  'combo: blur3+rotate45+scale3+noise60 (bad photo)': (img) =>
    noise(scaleDown(rotate(blur(img, 3), 45), 3), 60, 19),
};

test('Gate B: decode rate under synthetic degradation (measurement)', () => {
  // Precompute one clean rasterization per payload; every condition is
  // applied fresh to these, never chained onto another condition's output.
  const baseImages = payloads.map((p) => ({ payload: p, img: rasterize(encode(p), { px: PX }) }));

  const rows = [];
  let controlOk = 0;

  for (const [name, fn] of Object.entries(conditions)) {
    let ok = 0;
    for (const { payload, img } of baseImages) {
      const degraded = fn(img);
      const got = decode(degraded);
      if (got === payload) ok++;
    }
    if (name === 'control (none)') controlOk = ok;
    const total = baseImages.length;
    const pct = ((ok / total) * 100).toFixed(0).padStart(3, ' ');
    rows.push(`  ${name.padEnd(46, ' ')} ${String(ok).padStart(2)}/${total}  ${pct}%`);
  }

  const table =
    '\n=== Gate B decode-rate table (px=' +
    PX +
    ', ' +
    payloads.length +
    ' payloads per condition) ===\n' +
    rows.join('\n') +
    '\n';
  console.log(table);

  // The one genuine assertion: an undegraded control must still be 100%.
  // This is Gate A's invariant re-checked inside Gate B's own harness --
  // if this ever fails, the harness (or its condition wiring) is broken,
  // not just measuring a hard condition.
  assert.equal(controlOk, payloads.length, 'control (undegraded) must decode 100%; harness is measuring nothing');
});
