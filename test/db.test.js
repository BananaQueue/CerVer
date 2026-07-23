import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';

test('openDb creates documents and verify_log tables', () => {
  const db = openDb(':memory:');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('documents'));
  assert.ok(tables.includes('verify_log'));
});
