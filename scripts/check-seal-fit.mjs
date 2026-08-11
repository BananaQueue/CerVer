// Report whether the seal would land on top of anything, for any PDF.
//
//   node scripts/check-seal-fit.mjs <pdf> [mm]
//
// Exits non-zero if the seal would cover content, so it can gate a batch.
import { readFile } from 'node:fs/promises';
import { checkSealFit } from '../src/sealFit.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-seal-fit.mjs <pdf> [mm]');
  process.exit(2);
}
const mm = process.argv[3] ? Number(process.argv[3]) : undefined;

const rep = await checkSealFit(await readFile(file), mm ? { mm } : undefined);
const s = rep.seal;
console.log(
  `seal box: x ${s.x0.toFixed(1)}–${s.x1.toFixed(1)}, y ${s.y0.toFixed(1)}–${s.y1.toFixed(1)} pt` +
    `  (${(s.size / 72 * 25.4).toFixed(0)} mm)\n`
);

for (const p of rep.pages) {
  if (p.clear && !p.rules) {
    console.log(`page ${p.k}: clear`);
    continue;
  }
  if (p.clear) {
    console.log(`page ${p.k}: clear — crosses a rule, which is normal letterhead`);
    continue;
  }
  const bits = [];
  if (p.covered.length) bits.push(`covers text “${p.covered.join(' ')}”`);
  if (p.images) bits.push(`covers ${p.images} image(s)`);
  if (p.shapes) bits.push(`covers ${p.shapes} drawn shape(s)`);
  console.log(`page ${p.k}: ${bits.join('; ')}`);
  for (const h of p.hits.filter((h) => h.kind !== 'graphic' || !h.rule)) {
    const b = h.box;
    console.log(
      `   ${h.kind.padEnd(7)} x ${b.x0.toFixed(1)}–${b.x1.toFixed(1)}` +
        `  y ${b.y0.toFixed(1)}–${b.y1.toFixed(1)}` +
        (h.text ? `  “${h.text}”` : '')
    );
  }
}

console.log(rep.clear ? '\nOK — the seal covers nothing.' : '\nThe seal would cover content.');
process.exitCode = rep.clear ? 0 : 1;
