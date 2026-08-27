import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';

// The route is now gated off by default (spec §9.2/§10, Task 8 calibration) and
// answers 404 without this -- every assertion below would then pass or fail for
// the gate's reason rather than its own. Set for the whole file: `node --test`
// The route is on by default now, so this line is no longer load-bearing --
// kept anyway, explicit rather than implicit, so this file's assertions hold
// regardless of the default. node:test runs each test file in its own
// process, so this cannot leak into the gate test
// (test/appVerifyPageImageGate.test.js), which owns the off (CERVER_PAGE_IMAGE_OCR=0) case.
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

test('missing file -> 400', async () => {
  const app = buildApp({ db: openDb(':memory:'), verify: () => ({}), keyProvider: kp, sealedDir: '.' });
  // A well-formed but empty multipart body (no file part) — not a malformed
  // one. The close-delimiter needs its own leading "--" before the boundary
  // (RFC 2046); a body that omits it fails to parse at all and busboy answers
  // with its own 500 before this route's validation ever runs, which would
  // make this test pass for the wrong reason.
  const b = '----cerver';
  const res = await app.inject({
    method: 'POST', url: '/api/verify-page-image',
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
    payload: Buffer.from(`--${b}--\r\n`),
  });
  assert.equal(res.statusCode, 400);
});

test('missing doc or k -> 400', async () => {
  const app = buildApp({ db: openDb(':memory:'), verify: () => ({}), keyProvider: kp, sealedDir: '.' });
  const { body, headers } = form({ k: '1' }, Buffer.alloc(8));
  const res = await app.inject({ method: 'POST', url: '/api/verify-page-image', headers, payload: body });
  assert.equal(res.statusCode, 400);
});

test('an unknown document answers no_record_copy without running OCR', async () => {
  const app = buildApp({ db: openDb(':memory:'), verify: () => ({}), keyProvider: kp, sealedDir: '.' });
  const { body, headers } = form({ doc: 'R1-2099-999999', k: '1' }, Buffer.alloc(8));
  const res = await app.inject({ method: 'POST', url: '/api/verify-page-image', headers, payload: body });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'no_record_copy');
});
