// Proves src/ocr.js works against the INSTALLED tesseract.js and the vendored
// language data — with the network unavailable, which is the point.
//
//   node scripts/ocr-smoke.mjs <any-image-with-text.jpg>
//
// Not part of `npm test`: it loads a wasm engine and takes seconds. It proves
// the engine is WIRED UP. It measures nothing — accuracy is Task 8's job, on
// photographs of paper.
import fs from 'node:fs/promises';
import { recognize, shutdownOcr } from '../src/ocr.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/ocr-smoke.mjs <image-with-text>');
  process.exit(2);
}

const got = await recognize(await fs.readFile(file));
await shutdownOcr();

console.log(`confidence ${got.meanConfidence.toFixed(3)}, ${got.wordCount} words`);
console.log('---');
console.log(got.text.slice(0, 400));
console.log('---');
if (got.wordCount === 0) {
  console.error('FAIL: no text came back at all — the engine is not reading');
  process.exit(1);
}
console.log('OK');
