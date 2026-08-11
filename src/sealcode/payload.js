import { rsEncode, rsDecode } from './rs.js';

// Payload codec for the EMB seal code.
//
// Packs a page seal into 11 bytes, Reed-Solomon protects it to 23 bytes, and
// expands that to the 184 bits the mark carries.
//
//   header  1B  magic + version
//   year    1B  offset from 2000, so 2000..2255
//   serial  3B  up to 16.7M
//   page    1B  1..255
//   seal    5B  the full 40-bit seal, deliberately NOT truncated — weakening
//               the cryptographic seal to save a byte is a bad trade in a
//               verification system
//
// 11 data + 24 parity corrects up to 12 corrupted bytes of 35.
//
// The parity size is set by what the mark can hold, not by taste. There are 305
// carrier tiles; this uses 280 of them. It was 12 parity bytes using 184, which
// left 121 tiles carrying nothing at all — they were simply left inked, so a
// third of the mark's capacity was doing no work while reads were failing.
//
// Measured over 20,000 simulated reads per point (scripts/rs-bench.mjs), with
// each carried bit independently misread at probability p:
//
//        p     3.0%   3.5%   4.0%   4.5%
//   12 parity  64.5   54.4   44.9   32.9   % of reads that recover
//   24 parity  91.9   82.0   74.0   60.0
//
// 27 parity would fill the mark exactly and measures the same in that band, but
// slightly worse beyond it — more parity is also more surface to corrupt — so 24
// wins on the tail and leaves 25 tiles spare for a future field.

export const DATA_BYTES = 11;
export const NSYM = 24;
export const CODE_BYTES = DATA_BYTES + NSYM; // 23
export const TOTAL_BITS = CODE_BYTES * 8; // 184

const MAGIC = 0x1f;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RE = /^CVR\|R1-((?:20|21)\d\d)-(\d{6})\|(\d{1,3})\|([A-Z2-7]{4})-([A-Z2-7]{4})$/;

function pack(payload) {
  const m = String(payload || '').match(RE);
  if (!m) throw new Error('bad payload: ' + payload);
  const year = Number(m[1]);
  if (year < 2000 || year > 2255) throw new Error('bad payload: year out of range (2000-2255)');
  const serial = Number(m[2]);
  const page = Number(m[3]);
  if (page < 1 || page > 255) throw new Error('bad payload: page out of range (1-255)');
  let sealBits = 0n;
  for (const ch of (m[4] + m[5]).toUpperCase()) sealBits = (sealBits << 5n) | BigInt(B32.indexOf(ch));

  const d = new Uint8Array(DATA_BYTES);
  d[0] = MAGIC;
  d[1] = year - 2000;
  d[2] = (serial >> 16) & 0xff;
  d[3] = (serial >> 8) & 0xff;
  d[4] = serial & 0xff;
  d[5] = page;
  for (let i = 0; i < 5; i++) d[6 + i] = Number((sealBits >> BigInt((4 - i) * 8)) & 0xffn);
  return d;
}

function unpack(d) {
  if (!d || d[0] !== MAGIC) return null;
  const year = 2000 + d[1];
  const serial = (d[2] << 16) | (d[3] << 8) | d[4];
  const page = d[5];
  if (page < 1) return null;
  let sealBits = 0n;
  for (let i = 0; i < 5; i++) sealBits = (sealBits << 8n) | BigInt(d[6 + i]);
  let chars = '';
  for (let i = 7; i >= 0; i--) chars += B32[Number((sealBits >> BigInt(i * 5)) & 0x1fn)];
  const seal = chars.slice(0, 4) + '-' + chars.slice(4);
  return `CVR|R1-${year}-${String(serial).padStart(6, '0')}|${page}|${seal}`;
}

/** payload string -> bit array of length TOTAL_BITS (values 0/1), MSB first. */
export function encode(payload) {
  const code = rsEncode(pack(payload), NSYM);
  const bits = new Uint8Array(TOTAL_BITS);
  for (let i = 0; i < CODE_BYTES; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (code[i] >> (7 - b)) & 1;
  }
  return bits;
}

/** bit array -> payload string, or null if it does not decode. */
export function bitsToPayload(bits) {
  if (!bits || bits.length < TOTAL_BITS) return null;
  const code = new Uint8Array(CODE_BYTES);
  for (let i = 0; i < CODE_BYTES; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | (bits[i * 8 + b] & 1);
    code[i] = v;
  }
  const data = rsDecode(code, NSYM);
  if (!data) return null;
  return unpack(data);
}
