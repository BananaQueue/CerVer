import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createVerifier } from '../src/verifyService.js';

function seed() {
  const db = openDb(':memory:');
  db.prepare(
    "INSERT INTO documents (iis_no, subject_name, source, first_seen) VALUES ('R1-2025-028799','Special Order','excel','t')"
  ).run();
  return db;
}

test('local hit returns verified_local and logs', async () => {
  const db = seed();
  const verify = createVerifier({ db, iisLookup: async () => null });
  const r = await verify('R1-2025-028799');
  assert.equal(r.status, 'verified_local');
  assert.equal(r.record.subject_name, 'Special Order');
  const log = db.prepare('SELECT * FROM verify_log ORDER BY id DESC').get();
  assert.equal(log.outcome, 'local_hit');
  assert.equal(log.path, 'public');
});

test('public miss returns needs_staff and never calls iisLookup', async () => {
  const db = seed();
  let called = false;
  const verify = createVerifier({
    db,
    iisLookup: async () => {
      called = true;
      return null;
    },
  });
  const r = await verify('R1-2099-000001', { path: 'public' });
  assert.equal(r.status, 'needs_staff');
  assert.equal(called, false);
});

test('staff miss consults iisLookup, caches hit, returns verified_live', async () => {
  const db = seed();
  const verify = createVerifier({
    db,
    iisLookup: async (n) => ({ iis_no: n.canonicalId, subject_name: 'Live Doc' }),
  });
  const r = await verify('R1-2099-000002', { path: 'staff' });
  assert.equal(r.status, 'verified_live');
  const row = db.prepare('SELECT * FROM documents WHERE iis_no=?').get('R1-2099-000002');
  assert.equal(row.subject_name, 'Live Doc');
  assert.equal(row.source, 'iis_live');
});

test('invalid input returns invalid', async () => {
  const db = seed();
  const verify = createVerifier({ db, iisLookup: async () => null });
  const r = await verify('   ');
  assert.equal(r.status, 'invalid');
});
