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
