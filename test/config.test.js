import { test } from 'node:test';
import assert from 'node:assert/strict';

test('config honors env overrides', async () => {
  process.env.CERVER_DB = '/tmp/x.db';
  process.env.PORT = '4000';
  const { default: config } = await import('../src/config.js?ovr=1');
  assert.equal(config.dbPath, '/tmp/x.db');
  assert.equal(config.port, 4000);
});
