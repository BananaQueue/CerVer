import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';

// The page-image comparison endpoint shipped on by default 2026-08-25, once
// spec §9.2's calibration criteria held against real photographs.
// CERVER_PAGE_IMAGE_OCR=0 remains a kill switch -- explicitly OFF, not merely
// unset, is what withholds the route. /health advertises the same state so
// the frontend can hide the button, but /health is not a gate -- the route
// has to refuse on its own, the way /api/frame does for CERVER_FRAME_CAPTURE.
//
// Both directions, in one file so the env var is set and cleared per test
// rather than per process: this branch has shipped a one-directional flag test
// before, which passes just as happily against a route that is off
// unconditionally as against one that is gated.

const kp = { currentKid: () => '1', secretFor: () => 'test-secret' };

function form(fields, fileBytes) {
  const b = '----cerver';
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="page.jpg"\r\n`
    + 'Content-Type: image/jpeg\r\n\r\n'
  ));
  parts.push(Buffer.from(fileBytes));
  parts.push(Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

const appFor = () => buildApp({
  db: openDb(':memory:'), verify: () => ({}), keyProvider: kp, sealedDir: '.',
});

async function withFlag(value, fn) {
  const prev = process.env.CERVER_PAGE_IMAGE_OCR;
  if (value === undefined) delete process.env.CERVER_PAGE_IMAGE_OCR;
  else process.env.CERVER_PAGE_IMAGE_OCR = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CERVER_PAGE_IMAGE_OCR;
    else process.env.CERVER_PAGE_IMAGE_OCR = prev;
  }
}

test('the page-image route is 404 when explicitly disabled', async () => {
  await withFlag('0', async () => {
    // A well-formed request that WOULD be answered by default (see the next
    // test) -- so a 404 here can only come from the gate, not from the
    // route's own validation.
    const { body, headers } = form({ doc: 'R1-2099-999999', k: '1' }, Buffer.alloc(8));
    const res = await appFor().inject({
      method: 'POST', url: '/api/verify-page-image', headers, payload: body,
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'Page-image comparison is off.');
  });
});

test('the page-image route answers normally by default', async () => {
  await withFlag(undefined, async () => {
    const { body, headers } = form({ doc: 'R1-2099-999999', k: '1' }, Buffer.alloc(8));
    const res = await appFor().inject({
      method: 'POST', url: '/api/verify-page-image', headers, payload: body,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'no_record_copy');
  });
});

test('health reports the page-image feature off when explicitly disabled', async () => {
  await withFlag('0', async () => {
    const r = await appFor().inject({ method: 'GET', url: '/health' });
    assert.equal(JSON.parse(r.body).pageImageOcr, false);
  });
});

test('health reports the page-image feature on by default', async () => {
  await withFlag(undefined, async () => {
    const r = await appFor().inject({ method: 'GET', url: '/health' });
    assert.equal(JSON.parse(r.body).pageImageOcr, true);
  });
});
