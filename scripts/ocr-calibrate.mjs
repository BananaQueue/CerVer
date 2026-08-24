// Measure the page-image comparison against REAL PHOTOGRAPHS.
//
//   node scripts/ocr-calibrate.mjs <sealed.pdf> <photos-dir>
//
// Each photo is named "<pageNo>-<label>.jpg", where label is one of:
//   genuine   an unaltered printed page, photographed
//   altered   a page with a KNOWN changed value
//   poor      deliberately bad capture (angled, shadowed, cropped)
//   other     a page from a different document
//
// Renders of the PDF are NOT admissible here (spec §9.2). The size ladder
// already measured a capture bug off synthetic samples and reported it as a
// property of ink; this exists so that does not happen twice.
import fs from 'node:fs/promises';
import path from 'node:path';
import { recognize, shutdownOcr } from '../src/ocr.js';
import { compare } from '../src/pageCompare.js';
import { extractPageTexts } from '../src/pdfTools.js';
import { stripOcrFooter } from '../src/ocrFooter.js';

const [pdfPath, dir] = process.argv.slice(2);
if (!pdfPath || !dir) {
  console.error('usage: node scripts/ocr-calibrate.mjs <sealed.pdf> <photos-dir>');
  process.exit(2);
}

const texts = await extractPageTexts(await fs.readFile(pdfPath));
const files = (await fs.readdir(dir)).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();

console.log(['file', 'label', 'similarity', 'confidence', 'words', 'material', 'suppressed', 'status'].join('\t'));
const rows = [];
for (const f of files) {
  const [pageNo, label = 'genuine'] = path.parse(f).name.split('-');
  const read = await recognize(await fs.readFile(path.join(dir, f)));
  // Matches verifyPageImage.js's real order -- stripOcrFooter runs on the OCR
  // text before compare() sees it, same as the actual request path. Without
  // this the script measures a pipeline that no longer exists.
  const cleanedText = stripOcrFooter(read.text, read.words);
  const rep = compare(cleanedText, texts[Number(pageNo) - 1] ?? '');
  const material = rep.findings.filter((x) => x.severity === 'material');
  rows.push({ f, label, rep, read, material });
  console.log([
    f, label, rep.similarity.toFixed(3), read.meanConfidence.toFixed(3),
    read.wordCount, material.length, rep.suppressed, rep.status,
  ].join('\t'));
}
await shutdownOcr();

const genuine = rows.filter((r) => r.label === 'genuine');
const falsePositives = genuine.filter((r) => r.material.length > 0);
console.log('\n--- criterion 1: zero material false positives on genuine pages ---');
console.log(`${genuine.length} genuine page(s), ${falsePositives.length} with material findings`);
for (const r of falsePositives) {
  console.log(`  ${r.f}: ${r.material.map((m) => `${m.cls} ${m.expected} -> ${m.found} (${m.reason})`).join('; ')}`);
}

const sims = (label) => rows.filter((r) => r.label === label).map((r) => r.rep.similarity);
const min = (a) => (a.length ? Math.min(...a).toFixed(3) : 'n/a');
const max = (a) => (a.length ? Math.max(...a).toFixed(3) : 'n/a');
console.log('\n--- criterion 2: the samePageMin gap ---');
console.log(`genuine similarity floor: ${min(sims('genuine'))}`);
console.log(`other-page similarity ceiling: ${max(sims('other'))}`);
console.log('  pick samePageMin between these two, with margin on both sides.');

console.log('\n--- criterion 3: poor captures must land in image_unreadable ---');
for (const r of rows.filter((x) => x.label === 'poor')) {
  console.log(`  ${r.f}: confidence ${r.read.meanConfidence.toFixed(3)}, words ${r.read.wordCount}, status ${r.rep.status}`);
}

console.log('\n--- criterion 4: known alterations are caught ---');
for (const r of rows.filter((x) => x.label === 'altered')) {
  console.log(`  ${r.f}: ${r.material.length} material — ${r.material.map((m) => `${m.expected} -> ${m.found}`).join('; ') || 'CAUGHT NOTHING'}`);
}

process.exit(falsePositives.length === 0 ? 0 : 1);
