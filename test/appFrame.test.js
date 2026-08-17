import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createVerifier } from '../src/verifyService.js';
import { keyProvider } from '../src/sealKeys.js';
import { buildApp } from '../src/app.js';

// The diagnostic capture endpoint. It exists to receive a full-resolution frame
// off a phone, so the body limit has to admit one: the handler's own 8 MB guard
// is the intended ceiling, and the framework must not reject below it.

const framesDir = path.resolve('frames');
let before_ = new Set();

before(async () => {
  process.env.CERVER_FRAME_CAPTURE = '1';
  try {
    before_ = new Set(await readdir(framesDir));
  } catch {
    before_ = new Set();
  }
});

after(async () => {
  delete process.env.CERVER_FRAME_CAPTURE;
  // Remove only what this test wrote; real diagnostic captures live here too.
  let now = [];
  try {
    now = await readdir(framesDir);
  } catch {
    return;
  }
  for (const f of now) {
    if (!before_.has(f) && f.startsWith('frame-')) {
      await rm(path.join(framesDir, f), { force: true });
    }
  }
});

const appFor = () => {
  const db = openDb(':memory:');
  return buildApp({ db, verify: createVerifier({ db, iisLookup: async () => null }), keyProvider: keyProvider() });
};

/** A PNG data URL whose decoded size is about `bytes`. */
function pngDataUrl(bytes) {
  // Not a real PNG - the route only checks the data-URL shape and the size.
  return 'data:image/png;base64,' + Buffer.alloc(bytes, 7).toString('base64');
}

// The page cannot read the server's environment, so it has to ask. Without this
// the diagnostic button is shown to everyone and 404s when pressed.
test('health reports diagnostics off, so the page can hide the button', async () => {
  const prev = process.env.CERVER_FRAME_CAPTURE;
  delete process.env.CERVER_FRAME_CAPTURE;
  try {
    const r = await appFor().inject({ method: 'GET', url: '/health' });
    // pageImageOcr rides the same /health shape, gating a different feature
    // (see src/app.js) -- included here so this stays a real deepEqual on
    // the whole response rather than silently drifting into a subset check.
    assert.deepEqual(JSON.parse(r.body), { ok: true, frameCapture: false, pageImageOcr: false });
  } finally {
    if (prev === undefined) delete process.env.CERVER_FRAME_CAPTURE;
    else process.env.CERVER_FRAME_CAPTURE = prev;
  }
});

test('health reports diagnostics on when they are enabled', async () => {
  process.env.CERVER_FRAME_CAPTURE = '1';
  const r = await appFor().inject({ method: 'GET', url: '/health' });
  assert.equal(JSON.parse(r.body).frameCapture, true);
});

test('accepts a frame larger than the framework default body limit', async () => {
  // 700x700 captures landed near 600 KB; a 932x700 one clears 1 MiB, which is
  // fastify's default and where the upload was being cut off.
  const r = await appFor().inject({
    method: 'POST',
    url: '/api/frame',
    payload: { image: pngDataUrl(2 * 1024 * 1024), info: { score: 1 }, ua: 'test' },
  });
  assert.equal(r.statusCode, 200, r.body.slice(0, 200));
  assert.match(JSON.parse(r.body).file, /^frame-.*\.png$/);
});

test('still refuses a frame beyond the handler guard', async () => {
  const r = await appFor().inject({
    method: 'POST',
    url: '/api/frame',
    payload: { image: pngDataUrl(9 * 1024 * 1024), info: null, ua: 'test' },
  });
  assert.equal(r.statusCode, 413);
});
