import { test } from 'node:test';
import assert from 'node:assert/strict';
import { throttle, parseIisDocument, iisUrlFor } from '../src/iisLookup.js';

test('throttle serializes and spaces calls', async () => {
  const times = [];
  const fn = throttle(async (x) => {
    times.push(Date.now());
    return x;
  }, 50);
  const [a, b] = await Promise.all([fn(1), fn(2)]);
  assert.equal(a, 1);
  assert.equal(b, 2);
  assert.ok(times[1] - times[0] >= 45, `gap was ${times[1] - times[0]}ms`);
});

test('parseIisDocument returns null on not-found text', () => {
  assert.equal(
    parseIisDocument('No record found', { kind: 'iis_no', canonicalId: 'R1-2025-1' }),
    null
  );
});

test('parseIisDocument returns row when content present', () => {
  const r = parseIisDocument('Transaction R1-2025-028799 details ...', {
    kind: 'iis_no',
    canonicalId: 'R1-2025-028799',
  });
  assert.equal(r.iis_no, 'R1-2025-028799');
});

test('iisUrlFor builds preview URL for tokens', () => {
  assert.equal(
    iisUrlFor({ kind: 'token', canonicalId: 'abc123def456' }, 'https://iis.emb.gov.ph'),
    'https://iis.emb.gov.ph/embis/dar/preview2/abc123def456'
  );
});
