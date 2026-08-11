// Seal scripts/print-test.pdf and record the pages, so a printed
// copy can be scanned against the live server.
//
//   node scripts/seal-print-test.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { keyProvider } from '../src/sealKeys.js';
import { sealPdf } from '../src/sealer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IN = path.join(here, 'print-test.pdf');
const OUT = path.join(here, 'print-test-sealed.pdf');
const IIS_NO = 'R1-2026-010734';

const db = openDb(path.resolve('cerver.db'));
const { sealedBytes, kid, pages } = await sealPdf(db, {
  iisNo: IIS_NO,
  pdfBytes: await readFile(IN),
  keyProvider: keyProvider(),
  sealedPdfPath: OUT,
});
await writeFile(OUT, sealedBytes);

console.log(`sealed ${pages.length} pages with kid ${kid} -> ${OUT}\n`);
for (const p of pages) {
  console.log(`  page ${p.k}/${p.n}  seal ${p.seal}  digest ${p.digest.slice(0, 16)}…`);
}
