import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lattice, SPACE } from '../../src/leafcode/lattice.js';

test('lattice is deterministic and has 256 nodes + 3 anchors', () => {
  const a = lattice(), b = lattice();
  assert.equal(a.nodes.length, 256);
  assert.equal(a.anchors.length, 3);
  assert.deepEqual(a.nodes, b.nodes);
});
test('all nodes lie inside the canvas', () => {
  for (const n of lattice().nodes) {
    assert.ok(n.x >= 0 && n.x <= SPACE && n.y >= 0 && n.y <= SPACE);
  }
});
test('anchors form a scalene triangle (all sides distinct)', () => {
  const [A, B, C] = lattice().anchors;
  const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const s = [d(A, B), d(B, C), d(A, C)].sort((x, y) => x - y);
  assert.ok(s[1] - s[0] > 20 && s[2] - s[1] > 20);
});
test('every anchor stays at least minD away from every data node', () => {
  // Regression guard: the sampler must reject candidate nodes that fall too
  // close to a fixed anchor, not just too close to other nodes. Anchors are
  // drawn larger than nodes, so lattice() enforces a clearance (40 canonical
  // units) stricter than the node-to-node minD (24); we assert against the
  // weaker minD=24 bound here so this test documents the invariant that must
  // never regress, independent of the exact clearance constant chosen.
  const MIN_D = 24;
  const { nodes, anchors } = lattice();
  const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  let minAnchorNodeDist = Infinity;
  for (const a of anchors) {
    for (const n of nodes) {
      const dist = d(a, n);
      if (dist < minAnchorNodeDist) minAnchorNodeDist = dist;
    }
  }
  assert.ok(
    minAnchorNodeDist >= MIN_D,
    `expected every anchor to be >= ${MIN_D} units from every node, got ${minAnchorNodeDist}`
  );
});
