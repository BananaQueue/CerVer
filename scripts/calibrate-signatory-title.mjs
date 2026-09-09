// Real-photo calibration for the signatoryTitle class -- see
// docs/superpowers/specs/2026-09-09-signatory-title-comparison-design.md
// and docs/superpowers/plans/2026-09-09-signatory-title-comparison.md Task 3.
// Not part of `npm test` (real Tesseract OCR is slow) -- same convention
// scripts/ocr-calibrate.mjs already established. Re-run this whenever
// SIGNATORY_TITLE_SIMILARITY_FLOOR (src/pageCompare.js) needs revisiting,
// or a new real document/photo is added that exercises this class.
import { readFileSync } from 'node:fs';
import { recognize, shutdownOcr } from '../src/ocr.js';
import { extractPageTextsWithLines } from '../src/pdfTools.js';
import { compare, extractTokens, similarity } from '../src/pageCompare.js';

function foldWords(value) {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase().split(' ');
}

const docs = [
  {
    name: 'R1-2026-020780 (Special Order)',
    authPdf: 'sealed/R1-2026-020780.pdf',
    genuine: [
      'test/fixtures/pages-special-order-383/1-genuine.jpg',
      'test/fixtures/pages-special-order-383/1-altered.jpg',
      'test/fixtures/pages-special-order-383/1-altered-b.jpg',
      'test/fixtures/pages-special-order-383/1-altered-c.jpg',
      'test/fixtures/pages-special-order-383/1-altered-d.jpg',
    ],
    titleAltered: [
      'test/fixtures/pages-special-order-383/1-altered-e.jpg',
      'test/fixtures/pages-special-order-383/1-altered-e-b.jpg',
    ],
  },
  {
    name: 'R1-2026-010734 (Environmental Compliance Certificate, page 3)',
    authPdf: 'scripts/print-test-sealed.pdf',
    authPage: 2,
    genuine: ['test/fixtures/pages/3-genuine.jpg', 'test/fixtures/pages/3-genuine-b.jpg'],
    titleAltered: [],
  },
  {
    name: 'R1-2026-010734 (Environmental Compliance Certificate, page 1 -- no signature at all)',
    authPdf: 'scripts/print-test-sealed.pdf',
    authPage: 0,
    genuine: ['test/fixtures/pages/1-genuine.jpg', 'test/fixtures/pages/1-genuine-b.jpg', 'test/fixtures/pages/1-poor.jpg'],
    titleAltered: [],
  },
];

for (const doc of docs) {
  const authBytes = readFileSync(doc.authPdf);
  const authText = (await extractPageTextsWithLines(authBytes))[doc.authPage ?? 0];
  const authSigTitle = extractTokens(authText).find((t) => t.cls === 'signatoryTitle');
  console.log(`\n=== ${doc.name} ===`);
  console.log('record signatoryTitle:', JSON.stringify(authSigTitle));

  for (const file of [...doc.genuine, ...doc.titleAltered]) {
    const tag = doc.titleAltered.includes(file) ? 'title-altered' : 'genuine';
    const read = await recognize(readFileSync(file));
    const r = compare(read.text, authText);
    const findings = r.findings.filter((f) => f.cls === 'signatoryTitle');
    const photoSigTitle = extractTokens(read.text).find((t) => t.cls === 'signatoryTitle');
    let simScore = 'n/a';
    if (authSigTitle && photoSigTitle) {
      simScore = similarity(foldWords(authSigTitle.value), foldWords(photoSigTitle.value)).toFixed(3);
    }
    console.log(`[${tag}] ${file}`);
    console.log(`  photo signatoryTitle: ${JSON.stringify(photoSigTitle)}`);
    console.log(`  similarity to record: ${simScore}`);
    console.log(`  findings: ${JSON.stringify(findings)}`);
  }
}

await shutdownOcr();
