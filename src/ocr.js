// Image bytes -> text. The only nondeterministic part of page-image comparison;
// everything that decides what a difference MEANS lives in pageCompare.js.
//
// Language data is vendored (vendor/tesseract/) and langPath points at it, so
// nothing is fetched at runtime. See spec §8.
import { createWorker } from 'tesseract.js';
import config from './config.js';

let workerPromise = null;

// Starting a worker costs seconds, so one is shared. Created lazily: a server
// that never receives a page image never pays for it.
function worker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      langPath: config.ocrLangPath,
      gzip: false, // the vendored file is uncompressed
      cachePath: config.ocrLangPath,
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
    // tesseract reports 0..100; the rest of the app talks in 0..1.
    meanConfidence: Number.isFinite(data?.confidence) ? data.confidence / 100 : 0,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

export async function shutdownOcr() {
  if (!workerPromise) return;
  const w = await workerPromise;
  workerPromise = null;
  await w.terminate();
}
