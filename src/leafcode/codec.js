// LeafCode payload codec: packs a document-seal payload string into 13 data
// bytes, Reed-Solomon-encodes to a 32-byte codeword, and expands that to the
// 256 bits that become the 256 lattice dots — plus the exact inverse.
//
// Payload format: CVR|R1-YYYY-NNNNNN|k|XXXX-XXXX
//   YYYY   4-digit year (19xx or 20xx)
//   NNNNNN 6-digit serial
//   k      page number, 1-3 digits, valid range 1-255 (packed into 1 byte)
//   XXXX-XXXX  8-character base32 seal (alphabet below), split 4-4
//
// Packed to 13 data bytes: [0x1e, 0x01] header, year (2B BE), serial (3B
// BE), page (1B), seal (5B, packed from the 8 base32 chars at 5 bits each =
// 40 bits). RS with nsym=19 turns that into a 32-byte codeword, which is
// expanded MSB-first per byte into 256 bits.

import { rsEncode, rsDecode } from './rs.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const HEADER = [0x1e, 0x01]; // magic, version
const NSYM = 19;

function packPayload(payload) {
  const m = payload.match(/^CVR\|R1-((?:19|20)\d\d)-(\d{6})\|(\d{1,3})\|([A-Z2-7]{4})-([A-Z2-7]{4})$/);
  if (!m) throw new Error('bad payload: ' + payload);
  const year = Number(m[1]);
  const serial = Number(m[2]);
  const page = Number(m[3]);
  if (page < 1 || page > 255) throw new Error('bad payload: page out of range (1-255): ' + payload);
  const sealChars = (m[4] + m[5]).toUpperCase();
  let sealBits = 0n;
  for (const c of sealChars) sealBits = (sealBits << 5n) | BigInt(B32.indexOf(c)); // 40 bits
  const data = new Uint8Array(13);
  data[0] = HEADER[0];
  data[1] = HEADER[1];
  data[2] = (year >> 8) & 0xff;
  data[3] = year & 0xff;
  data[4] = (serial >> 16) & 0xff;
  data[5] = (serial >> 8) & 0xff;
  data[6] = serial & 0xff;
  data[7] = page & 0xff;
  for (let i = 0; i < 5; i++) data[8 + i] = Number((sealBits >> BigInt((4 - i) * 8)) & 0xffn);
  return data;
}

function unpackPayload(data) {
  if (data[0] !== HEADER[0] || data[1] !== HEADER[1]) return null;
  const year = (data[2] << 8) | data[3];
  const serial = (data[4] << 16) | (data[5] << 8) | data[6];
  const page = data[7];
  let sealBits = 0n;
  for (let i = 0; i < 5; i++) sealBits = (sealBits << 8n) | BigInt(data[8 + i]);
  let chars = '';
  for (let i = 7; i >= 0; i--) chars += B32[Number((sealBits >> BigInt(i * 5)) & 0x1fn)];
  const seal = chars.slice(0, 4) + '-' + chars.slice(4);
  const serialStr = String(serial).padStart(6, '0');
  return `CVR|R1-${year}-${serialStr}|${page}|${seal}`;
}

export function encode(payload) {
  const code = rsEncode(packPayload(payload), NSYM); // 32 bytes
  const bits = new Uint8Array(256);
  for (let i = 0; i < 32; i++)
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (code[i] >> (7 - b)) & 1;
  return bits;
}

export function bitsToPayload(bits) {
  const code = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | (bits[i * 8 + b] & 1);
    code[i] = v;
  }
  const data = rsDecode(code, NSYM);
  if (!data) return null;
  return unpackPayload(data);
}
