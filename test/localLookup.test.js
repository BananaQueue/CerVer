import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { localLookup } from '../src/localLookup.js';

test('localLookup returns row or null', () => {
  const db = openDb(':memory:');
  db.prepare(
    "INSERT INTO documents (iis_no, subject_name, source, first_seen) VALUES ('R1-2025-1','Hello','excel','t')"
  ).run();
  assert.equal(localLookup(db, 'R1-2025-1').subject_name, 'Hello');
  assert.equal(localLookup(db, 'R1-2025-9'), null);
});
