// Geometry drift guard.
//
// WHY THIS FILE EXISTS: lattice.js, raster.js, render.js, and decode.js each
// duplicate a handful of geometry constants (MIN_D, NODE_R_FACTOR,
// ANCHOR_R_FACTOR, RING_WIDTH_FACTOR) and, in raster.js/render.js, an
// identical defaultRadii() helper. This duplication is BY DESIGN -- those
// modules are frozen and deliberately independent (raster.js is a pure-JS
// test double standing in for a browser rasterizer; render.js is the real
// printable SVG artwork; decode.js must reconstruct the same geometry from a
// bare image, with no import access to either module's internals). Nothing
// in the source itself enforces that the duplicated numbers stay in sync.
//
// Today the ONLY thing that would catch a drift between render.js and
// decode.js is scripts/leafcode-parity.mjs, which needs a real headless
// Chrome browser via Playwright and is NOT part of `node --test`. A silent
// geometry drift (e.g. someone tweaking NODE_R_FACTOR in one file but not
// the others) would currently pass all of `node --test test/leafcode/*`.
//
// This file is a pure node:test guard with no browser dependency: it fails
// loudly, in the fast unit-test suite, the moment any of these duplicated
// numbers disagree. It does NOT refactor the modules to share the
// constants -- that is explicitly out of scope; this is a tripwire, not a
// fix for the duplication itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SPACE } from '../../src/leafcode/lattice.js';
import { defaultRadii as rasterDefaultRadii } from '../../src/leafcode/raster.js';
import { defaultRadii as renderDefaultRadii } from '../../src/leafcode/render.js';

function readSrc(relPath) {
  return readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// Pull a `const NAME = <number>` declaration's numeric value out of a
// module's source text. Used only for constants the modules deliberately do
// NOT export (they are frozen and not to be modified to add exports), so
// this is the only way to compare them without changing the modules.
function extractConst(src, name) {
  const re = new RegExp(`const ${name}\\s*=\\s*([0-9.]+)`);
  const m = src.match(re);
  assert.ok(m, `expected to find "const ${name} = <number>" in source`);
  return Number(m[1]);
}

const latticeSrc = readSrc('../../src/leafcode/lattice.js');
const rasterSrc = readSrc('../../src/leafcode/raster.js');
const renderSrc = readSrc('../../src/leafcode/render.js');
const decodeSrc = readSrc('../../src/leafcode/decode.js');

test('raster.js and render.js compute identical radii for the same px (defaultRadii helper)', () => {
  for (const px of [800, 1000, 1200, 1600]) {
    const r = rasterDefaultRadii(px);
    const v = renderDefaultRadii(px);
    assert.equal(r.nodeR, v.nodeR, `nodeR mismatch at px=${px}: raster.js=${r.nodeR} render.js=${v.nodeR}`);
    assert.equal(r.anchorR, v.anchorR, `anchorR mismatch at px=${px}: raster.js=${r.anchorR} render.js=${v.anchorR}`);
  }
});

test('MIN_D agrees across lattice.js, raster.js, render.js, and decode.js', () => {
  const values = {
    'lattice.js': extractConst(latticeSrc, 'MIN_D'),
    'raster.js': extractConst(rasterSrc, 'MIN_D'),
    'render.js': extractConst(renderSrc, 'MIN_D'),
    'decode.js': extractConst(decodeSrc, 'MIN_D'),
  };
  const distinct = new Set(Object.values(values));
  assert.equal(distinct.size, 1, `MIN_D disagrees across modules: ${JSON.stringify(values)}`);
});

test('NODE_R_FACTOR agrees across raster.js, render.js, and decode.js', () => {
  const values = {
    'raster.js': extractConst(rasterSrc, 'NODE_R_FACTOR'),
    'render.js': extractConst(renderSrc, 'NODE_R_FACTOR'),
    'decode.js': extractConst(decodeSrc, 'NODE_R_FACTOR'),
  };
  const distinct = new Set(Object.values(values));
  assert.equal(distinct.size, 1, `NODE_R_FACTOR disagrees across modules: ${JSON.stringify(values)}`);
});

test('ANCHOR_R_FACTOR agrees between raster.js and render.js', () => {
  const a = extractConst(rasterSrc, 'ANCHOR_R_FACTOR');
  const b = extractConst(renderSrc, 'ANCHOR_R_FACTOR');
  assert.equal(a, b, `ANCHOR_R_FACTOR disagrees: raster.js=${a} render.js=${b}`);
});

test('RING_WIDTH_FACTOR agrees between raster.js and render.js', () => {
  const a = extractConst(rasterSrc, 'RING_WIDTH_FACTOR');
  const b = extractConst(renderSrc, 'RING_WIDTH_FACTOR');
  assert.equal(a, b, `RING_WIDTH_FACTOR disagrees: raster.js=${a} render.js=${b}`);
});

test("decode.js's canonical node radius (NODE_R_FACTOR * MIN_D) matches raster.js's node radius at scale 1", () => {
  const minD = extractConst(decodeSrc, 'MIN_D');
  const nodeRFactor = extractConst(decodeSrc, 'NODE_R_FACTOR');
  const canonFromDecode = nodeRFactor * minD;
  const canonFromRaster = rasterDefaultRadii(SPACE).nodeR; // scale 1 at px = SPACE
  assert.ok(
    Math.abs(canonFromDecode - canonFromRaster) < 1e-9,
    `decode.js's canonical node radius (${canonFromDecode}) should equal raster.js's node radius at px=SPACE (${canonFromRaster})`
  );
});
