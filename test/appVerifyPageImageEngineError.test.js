import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';

// Companion to test/appVerifyPageImage.test.js, added separately (rather than
// appended there) so that file is left untouched per task constraints. Same
// multipart-building helper, copied verbatim so this file has no dependency
// on the other test file's internals.
//
// Covers task 7 fix 2b: when verifyPageImage rejects, the route must catch it
// and answer 502 {status:'ocr_engine_error', error}, not let it fall through
// to Fastify's generic {statusCode,error,message} 500 -- which has no
// `status` and no `findings`, and is what made the frontend misreport a
// broken engine as "Couldn't reach the service" (task 7 fix 2c covers that
// side separately).

// Same reason as in test/appVerifyPageImage.test.js: the route is gated off by
// default now, so without this the 502 assertion below would never be reached.
process.env.CERVER_PAGE_IMAGE_OCR = '1';

const kp = { currentKid: () => '1', secretFor: () => 'test-secret' };

function form(fields, fileBytes) {
  const b = '----cerver';
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="page.jpg"\r\n` +
    'Content-Type: image/jpeg\r\n\r\n'
  ));
  parts.push(Buffer.from(fileBytes));
  parts.push(Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

test('a rejected verifyPageImage answers 502 ocr_engine_error, not a generic 500', async () => {
  const db = openDb(':memory:');
  // buildApp itself calls db.prepare(...) synchronously while constructing
  // the page verifier, so the real db must be usable at build time -- only
  // AFTER that is the page-lookup query (the one verifyPageImage issues)
  // made to fail, simulating a downstream break that surfaces as a rejected
  // promise from verifyPageImage. The route's job under test is purely "any
  // rejection becomes a proper 502", regardless of what caused it.
  const app = buildApp({ db, verify: () => ({}), keyProvider: kp, sealedDir: '.' });

  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql, ...rest) => {
    if (typeof sql === 'string' && sql.includes('sealed_pdf_path FROM pages')) {
      throw new Error('simulated downstream failure');
    }
    return realPrepare(sql, ...rest);
  };

  const { body, headers } = form({ doc: 'R1-2026-000001', k: '1' }, Buffer.alloc(8));
  const res = await app.inject({ method: 'POST', url: '/api/verify-page-image', headers, payload: body });

  assert.equal(res.statusCode, 502);
  const json = res.json();
  assert.equal(json.status, 'ocr_engine_error');
  assert.ok(json.error, 'must carry the underlying error message');
  // Not Fastify's generic error shape.
  assert.equal(json.statusCode, undefined);
});
