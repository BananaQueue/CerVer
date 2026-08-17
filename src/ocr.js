// Image bytes -> text. The only nondeterministic part of page-image comparison;
// everything that decides what a difference MEANS lives in pageCompare.js.
//
// Language data is vendored (vendor/tesseract/) and langPath points at it, so
// nothing is fetched at runtime. See spec §8.
import { createWorker } from 'tesseract.js';
import config from './config.js';

let workerPromise = null;

// Worker creation must finish within this window. A legitimate first start
// costs a few seconds (spin up the wasm worker, read the vendored ~4 MB
// eng.traineddata) and every later call reuses the same worker for free, so
// 30s leaves generous headroom without risking a false trip on a slow but
// healthy machine. This only exists to catch a genuinely stalled start: a
// failure inside tesseract.js's loadLanguage stage is swallowed by an
// internal `.catch(() => {})` (see
// node_modules/tesseract.js/src/createWorker.js), so createWorker()'s
// promise can simply never settle instead of rejecting. Without this
// timeout that stall would hang every recognize() call forever.
const WORKER_START_TIMEOUT_MS = 30_000;

function createWorkerWithTimeout() {
  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const succeed = (w) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(w);
    };

    const timer = setTimeout(() => {
      fail(new Error(
        `OCR engine failed to start: worker creation did not complete within `
        + `${WORKER_START_TIMEOUT_MS}ms (langPath=${config.ocrLangPath}). The `
        + 'engine itself could not initialize -- this is not the same as the '
        + 'engine reading a page and finding no text.',
      ));
    }, WORKER_START_TIMEOUT_MS);

    createWorker('eng', 1, {
      langPath: config.ocrLangPath,
      gzip: false, // the vendored file is uncompressed
      // A scratch dir, deliberately not the vendored langPath: on an
      // api.Init() failure tesseract.js deletes
      // `${cachePath}/eng.traineddata`, and if cachePath were the vendored
      // dir that call would delete the working tree's only copy of it.
      cachePath: config.ocrCachePath,
      // Without an errorHandler, tesseract.js's internal message handler
      // rethrows a worker-level error (e.g. loadLanguage failing because
      // eng.traineddata is missing) SYNCHRONOUSLY as an uncaught exception,
      // crashing the whole process instead of rejecting the createWorker()
      // promise (see node_modules/tesseract.js/src/createWorker.js, the
      // `else { throw Error(data) }` branch). Supplying a handler here turns
      // that crash into an ordinary rejection we can recover from.
      errorHandler: (err) => fail(new Error(`OCR engine failed to start: ${err?.message ?? err}`)),
    }).then(
      succeed,
      (err) => fail(new Error(`OCR engine failed to start: ${err?.message ?? err}`)),
    );
  });
}

// A failed createWorker() still leaves a worker_threads.Worker running: the
// underlying tesseract.js call (node_modules/tesseract.js/src/createWorker.js)
// spawns that thread immediately, before any of the load-stage checks that
// can fail, and a failure there rejects OUR promise without ever handing back
// a worker object to call .terminate() on -- so the thread is simply
// abandoned. Clearing workerPromise on failure (below, unchanged) is correct
// so the NEXT call gets a fresh attempt instead of replaying a dead rejection
// forever -- but if the engine is persistently broken (corrupted vendored
// data, disk pressure, a slow machine tripping WORKER_START_TIMEOUT_MS),
// every retry leaks one more thread, and every POST to the unauthenticated
// /api/verify-page-image route triggers a retry.
//
// This cooldown bounds that to roughly one abandoned worker per window: once
// createWorker fails, the same rejection is replayed for FAILURE_COOLDOWN_MS
// instead of attempting a new one. 60s is long enough to actually matter
// under sustained load (a burst of requests during an outage collapses to
// ~1 attempt/minute instead of 1/request) but short enough that a transient
// failure -- one bad request, a disk hiccup -- does not lock out legitimate
// use for long once the underlying problem clears.
const FAILURE_COOLDOWN_MS = 60_000;
let lastFailure = null; // { at: number, err: Error } | null

// Starting a worker costs seconds, so one is shared. Created lazily: a server
// that never receives a page image never pays for it.
function worker() {
  if (!workerPromise) {
    if (lastFailure && Date.now() - lastFailure.at < FAILURE_COOLDOWN_MS) {
      return Promise.reject(lastFailure.err);
    }
    // If creation fails, clear workerPromise so the NEXT call (once the
    // cooldown above has elapsed) gets a fresh attempt instead of replaying
    // this same rejection forever.
    workerPromise = createWorkerWithTimeout().catch((err) => {
      workerPromise = null;
      lastFailure = { at: Date.now(), err };
      throw err;
    });
  }
  return workerPromise;
}

export async function recognize(imageBytes) {
  const w = await worker();
  const { data } = await w.recognize(Buffer.from(imageBytes));
  const text = String(data?.text ?? '');
  return {
    text,
    // tesseract reports 0..100; the rest of the app talks in 0..1. Some
    // builds report -1 (still Number.isFinite) when nothing was recognized,
    // so clamp rather than let a blank read report a negative confidence.
    meanConfidence: Number.isFinite(data?.confidence)
      ? Math.min(1, Math.max(0, data.confidence / 100))
      : 0,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

export async function shutdownOcr() {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = null; // reset up front: safe to call again immediately, even mid-await
  let w;
  try {
    w = await pending;
  } catch {
    return; // creation never succeeded -- nothing to terminate
  }
  await w.terminate();
}
