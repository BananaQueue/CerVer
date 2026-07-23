import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { reindex } from '../src/indexer.js';
import { makeFixture } from './fixtures/make-fixture.js';

test('reindex loads rows, skips blank IIS no, and is idempotent', async () => {
  const file = await makeFixture();
  const db = openDb(':memory:');

  const first = await reindex(db, file);
  assert.equal(first.total, 2);
  assert.equal(first.inserted, 2);

  const row = db.prepare('SELECT * FROM documents WHERE iis_no=?').get('R1-2026-002465');
  assert.equal(row.transaction_type, 'NOTICE OF VIOLATION');
  assert.equal(row.attachment_ref, 'R1-2026-002465/');
  assert.equal(row.source, 'excel');

  const second = await reindex(db, file);
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 2);
  const count = db.prepare('SELECT COUNT(*) c FROM documents').get().c;
  assert.equal(count, 2);
});
