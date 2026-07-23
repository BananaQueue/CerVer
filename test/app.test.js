import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createVerifier } from '../src/verifyService.js';
import { buildApp } from '../src/app.js';

test('GET /api/verify returns verified_local for seeded id', async () => {
  const db = openDb(':memory:');
  db.prepare(
    "INSERT INTO documents (iis_no, subject_name, source, first_seen) VALUES ('R1-2025-028799','Special Order','excel','t')"
  ).run();
  const verify = createVerifier({ db, iisLookup: async () => null });
  const app = buildApp({ db, verify });
  const res = await app.inject({ method: 'GET', url: '/api/verify/R1-2025-028799' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'verified_local');
  assert.equal(body.record.subject_name, 'Special Order');
  await app.close();
});

test('public miss is needs_staff', async () => {
  const db = openDb(':memory:');
  const verify = createVerifier({ db, iisLookup: async () => null });
  const app = buildApp({ db, verify });
  const res = await app.inject({ method: 'GET', url: '/api/verify/R1-2099-000001' });
  assert.equal(res.json().status, 'needs_staff');
  await app.close();
});
