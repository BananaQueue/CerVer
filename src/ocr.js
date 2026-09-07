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

// data.words is not flat -- tesseract.js nests recognition results as
// Page.blocks[].paragraphs[].lines[].words[], and `blocks` is only populated
// when explicitly requested via recognize()'s third argument (see below).
// Flattened here once so the rest of the app never has to know this shape.
function flattenWords(data) {
  const out = [];
  for (const block of data?.blocks ?? []) {
    for (const para of block?.paragraphs ?? []) {
      for (const line of para?.lines ?? []) {
        for (const word of line?.words ?? []) out.push(word);
      }
    }
  }
  return out;
}

// Tesseract's own data.confidence is a straight mean over every detected
// "word," including bare punctuation it scores near 0% almost reflexively --
// a real photo (page 2 of a "Special Order" memo) read its substantive
// content cleanly but still measured meanConfidence 0.62, dragged down by
// ~40 near-zero punctuation detections, and was wrongly rejected as
// image_unreadable. Averaging only over content-bearing words (2+
// alphanumeric characters) fixes that specific photo without narrowing the
// gap against genuinely poor captures -- see
// docs/superpowers/specs/2026-08-27-content-word-confidence-design.md §2 for
// the measured data.
//
// words is the already-mapped array recognize() builds below (confidence
// already normalized to 0..1) -- data is the raw Tesseract page result,
// needed only for the fallback's own 0..100 confidence.
export function contentConfidence(words, data) {
  const contentWords = words.filter((w) => /[a-zA-Z0-9]{2,}/.test(w.text));
  if (contentWords.length === 0) {
    // Nothing to average over (a blank or fully illegible capture) --
    // falls back to Tesseract's own page-level average rather than
    // returning 0, which would make "read fine, just no content words"
    // indistinguishable from "read nothing." Same 0..100 -> 0..1 clamp
    // recognize() has always applied.
    return Number.isFinite(data?.confidence)
      ? Math.min(1, Math.max(0, data.confidence / 100))
      : 0;
  }
  return contentWords.reduce((sum, w) => sum + w.confidence, 0) / contentWords.length;
}

export async function recognize(imageBytes) {
  const w = await worker();
  // { blocks: true } requests the block/paragraph/line/word tree -- without
  // it data.blocks is null and there is no per-word confidence or bbox at
  // all, only the flattened text and page-wide mean this function already
  // returned before locateFindings() needed anything more granular.
  const { data } = await w.recognize(Buffer.from(imageBytes), {}, { blocks: true });
  const text = String(data?.text ?? '');
  // Per-word confidence and position, for locateFindings() (src/ocrRegions.js)
  // to draw a box at a finding's actual location on the photo, AND for
  // contentConfidence above (built first so meanConfidence can use it).
  // bbox is passed through unchanged; it's already in the original photo's
  // pixel space, which is what the frontend needs (spec 2026-08-17 §7).
  const words = flattenWords(data).map((word) => ({
    text: String(word?.text ?? ''),
    confidence: Number.isFinite(word?.confidence)
      ? Math.min(1, Math.max(0, word.confidence / 100))
      : 0,
    bbox: {
      x0: word?.bbox?.x0 ?? 0,
      y0: word?.bbox?.y0 ?? 0,
      x1: word?.bbox?.x1 ?? 0,
      y1: word?.bbox?.y1 ?? 0,
    },
  }));
  return {
    text,
    meanConfidence: contentConfidence(words, data),
    wordCount: text.split(/\s+/).filter(Boolean).length,
    words,
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
