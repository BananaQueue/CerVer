import { rsEncode, rsDecode } from '../leafcode/rs.js';
import { dataCells } from './mask.js';

// GridLeaf payload codec — a trimmed version of the LeafCode packing.
//
// Budget: a 28x28 grid over the disc leaves 230 DATA cells after the frond and
// band motif claim their fixed cells, so 23 bytes
// (184 bits) fit. Spent as 11 data + 12 parity, correcting up to 6 corrupted
// bytes of 23 (~26% redundancy).
//
// Trimming vs the original 13-byte packing:
//   header  2B -> 1B  (magic and version packed into one byte)
//   year    2B -> 1B  (offset from 2000, so 2000..2255)
//   serial  3B        (unchanged, up to 16.7M)
//   page    1B        (unchanged, 1..255)
//   seal    5B        (unchanged — the full 40-bit seal is deliberately NOT
//                      truncated; weakening the cryptographic seal to save one
//                      byte is a bad trade in a verification system)

export const COLS = 28;
export const DATA_BYTES = 11;
export const NSYM = 12;
export const CODE_BYTES = DATA_BYTES + NSYM; // 23
export const TOTAL_BITS = CODE_BYTES * 8; // 184

const MAGIC = 0x1f;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RE = /^CVR\|R1-((?:20|21)\d\d)-(\d{6})\|(\d{1,3})\|([A-Z2-7]{4})-([A-Z2-7]{4})$/;

export function usableCells() {
  return dataCells(COLS).length;
}

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
