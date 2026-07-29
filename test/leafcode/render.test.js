import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSvg, defaultRadii } from '../../src/leafcode/render.js';
import { encode } from '../../src/leafcode/codec.js';
import { lattice, SPACE } from '../../src/leafcode/lattice.js';

// Same canonical payload used by test/leafcode/raster.test.js and
// test/leafcode/gateB.test.js (the brief's own sample seal, '7F2A-9C41', is
// invalid under the base32 alphabet the codec enforces -- see
// test/leafcode/codec.test.js).
const PAYLOAD = 'CVR|R1-2026-010734|3|TQQ3-MTBT';

test('renderSvg returns an svg string with nodes and anchors', () => {
  const svg = renderSvg(encode(PAYLOAD));
  assert.match(svg, /^<svg/);
  assert.ok(svg.trim().endsWith('</svg>'));
  // 256 node marks + 3 anchors + 259 clearance halos = 518 <circle> tags for
  // solid nodes/anchors alone; hollow nodes also render as <circle> (ring),
  // so every node contributes at least one <circle> either way.
  assert.ok((svg.match(/<circle/g) || []).length > 200);
  assert.equal((svg.match(/<polygon/g) || []).length, 3);
});

test('renderSvg defaults to px = SPACE (1000)', () => {
  const svg = renderSvg(encode(PAYLOAD));
  assert.match(svg, /width="1000"/);
  assert.match(svg, /height="1000"/);
  assert.match(svg, new RegExp(`viewBox="0 0 ${SPACE} ${SPACE}"`));
});

test('renderSvg honours a custom px', () => {
  const svg = renderSvg(encode(PAYLOAD), { px: 800 });
  assert.match(svg, /width="800"/);
  assert.match(svg, /height="800"/);
});

test('geometry matches raster.js radii formulas at px=1000', () => {
  const { nodeR, anchorR } = defaultRadii(SPACE);
  // NODE_R_FACTOR * MIN_D * (px/SPACE) = 0.36 * 24 * 1 = 8.64
  assert.ok(Math.abs(nodeR - 8.64) < 1e-9, `nodeR should be 8.64, got ${nodeR}`);
  // ANCHOR_R_FACTOR * nodeR = 1.8 * 8.64 = 15.552
  assert.ok(Math.abs(anchorR - 15.552) < 1e-6, `anchorR should be 15.552, got ${anchorR}`);
});

// Escape regex metacharacters (notably '.') so a formatted coordinate like
// "123.45" is matched literally rather than "123" + any-char + "45".
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('every node position from lattice() appears as a mark centre (both x AND y) in the svg', () => {
  const bits = encode(PAYLOAD);
  const svg = renderSvg(bits);
  const { nodes, anchors } = lattice();
  const px = SPACE; // default renderSvg px
  const s = px / SPACE; // 1 at default px
  for (const n of nodes) {
    const cxNum = Number((n.x * s).toFixed(2));
    const cyNum = Number((n.y * s).toFixed(2));
    const cxFrag = escapeRegex(String(cxNum));
    const cyFrag = escapeRegex(String(cyNum));
    // fmt() in render.js rounds to 2dp and may differ by trailing zero
    // formatting, so match the numeric prefix rather than the exact string.
    // Requiring cx AND cy together (in that order, as render.js emits them)
    // closes the hole where only cx was checked -- a renderer that flipped
    // or transposed the y axis would still have satisfied a cx-only match
    // but fails this. The white clearance halo is drawn at the same (cx,cy)
    // as its mark, so matching either tag still correctly proves the node
    // position itself is present in the artwork.
    const re = new RegExp(`cx="${cxFrag}(\\.\\d+)?" cy="${cyFrag}(\\.\\d+)?"`);
    assert.ok(re.test(svg), `expected a mark centre at (${cxNum}, ${cyNum})`);
  }
  assert.equal(anchors.length, 3);
});

test('solid (bit=1) nodes render as filled dark circles, hollow (bit=0) as white-fill/dark-stroke rings', () => {
  const bits = new Uint8Array(256).fill(1);
  const svgAllSolid = renderSvg(bits);
  // No stroked (ring) node circles when every bit is 1: the only
  // stroke="#0a0a0a" circles would come from hollow nodes, so none should
  // exist.
  assert.ok(!/fill="#ffffff" stroke="#0a0a0a"/.test(svgAllSolid));

  const bits0 = new Uint8Array(256).fill(0);
  const svgAllHollow = renderSvg(bits0);
  assert.ok(/fill="#ffffff" stroke="#0a0a0a"/.test(svgAllHollow));
});

test('decoration is present but light/low-opacity, never solid dark fill', () => {
  const svg = renderSvg(encode(PAYLOAD));
  assert.match(svg, /stroke-opacity="0.22"/);
  // The decorative group must never carry a dark fill (only stroke).
  const groupMatch = svg.match(/<g fill="none"[^>]*>[\s\S]*?<\/g>/);
  assert.ok(groupMatch, 'expected a decoration <g> group');
  assert.ok(!/fill="#0a0a0a"/.test(groupMatch[0]), 'decoration must not use the mark-dark fill colour');
});

test('renderSvg can be called with decoration disabled', () => {
  const svg = renderSvg(encode(PAYLOAD), { decorate: false });
  assert.ok(!/<path/.test(svg));
  assert.ok((svg.match(/<polygon/g) || []).length === 3);
});
