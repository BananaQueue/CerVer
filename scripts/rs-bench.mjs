// How much noise does the seal's error correction actually survive?
//
//   node scripts/rs-bench.mjs
//
// The mark has 305 carrier tiles. The payload needs 11 data bytes; the rest is
// Reed-Solomon parity, and whatever is left over is simply left inked. This
// measures, per candidate parity size, the fraction of reads that still recover
// the payload when each carried bit is misread with probability p.
//
// Errors in unused carriers cost nothing — the decoder never looks at them — so
// a smaller code is not automatically worse, and the comparison has to be run
// rather than argued.
import { rsEncode, rsDecode } from '../src/sealcode/rs.js';

const CARRIERS = 305;
const DATA = 11;
const TRIALS = 4000;
const RATES = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10];

// A deterministic generator, so a run is comparable with the run before it.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function trial(nsym, p) {
  const data = new Uint8Array(DATA);
  for (let i = 0; i < DATA; i++) data[i] = (rand() * 256) | 0;
  const code = rsEncode(data, nsym);

  // to bits, flip, and back
  const got = Uint8Array.from(code);
  for (let i = 0; i < code.length; i++) {
    let v = code[i];
    for (let b = 0; b < 8; b++) if (rand() < p) v ^= 1 << (7 - b);
    got[i] = v;
  }

  const out = rsDecode(got, nsym);
  if (!out) return false;
  for (let i = 0; i < DATA; i++) if (out[i] !== data[i]) return false;
  return true;
}

const candidates = [];
for (const nsym of [12, 16, 20, 24, 27]) {
  const bits = (DATA + nsym) * 8;
  if (bits <= CARRIERS) candidates.push(nsym);
}

console.log(`carriers ${CARRIERS}, data ${DATA} bytes, ${TRIALS} trials per cell\n`);
console.log(
  'parity  bits used  corrects  ' + RATES.map((r) => `${(r * 100).toFixed(0)}%`.padStart(6)).join('')
);

for (const nsym of candidates) {
  const bits = (DATA + nsym) * 8;
  const row = RATES.map((p) => {
    let ok = 0;
    for (let t = 0; t < TRIALS; t++) if (trial(nsym, p)) ok++;
    return `${((ok / TRIALS) * 100).toFixed(1)}`.padStart(6);
  });
  console.log(
    `${String(nsym).padStart(6)}  ${String(bits).padStart(9)}  ${String(Math.floor(nsym / 2)).padStart(8)}  ` +
      row.join('')
  );
}
console.log('\n(cells are % of reads that recover the payload)');
