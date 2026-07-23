import crypto from 'node:crypto';

// Per-page seal primitives. Pure functions — no I/O, no PDF, no DB.
// A seal binds (IIS_No, page k of n, content digest) under a server secret.

const SEP = ' · '; // " · "
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Whitespace-collapsed text, so hashing is stable across layout/extraction noise.
export function canonicalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// Matches the footer we stamp, tolerant of the extra spaces pdf extraction adds.
const FOOTER_RE =
  /EMB\s*·\s*[A-Z0-9-]+\s*·\s*p\d+\/\d+\s*·\s*K[0-9A-Za-z]+\s*·\s*[0-9A-Z]{4}-[0-9A-Z]{4}/g;

// Remove our own seal footer before hashing page content (so seal ∉ digest).
export function stripFooter(text) {
  return canonicalize(String(text ?? '').replace(FOOTER_RE, ' '));
}

// SHA-256 hex of the canonical page body.
export function digestPage(canonicalBody) {
  return crypto.createHash('sha256').update(canonicalize(canonicalBody)).digest('hex');
}

function base32(buf) {
  let bits = 0;
  let val = 0;
  let out = '';
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

// seal = base32(HMAC(secret, iisNo|k|n|digest))[0:8] formatted XXXX-XXXX
export function computeSeal(secret, { iisNo, k, n, digest }) {
  const msg = `${iisNo}|${k}|${n}|${digest}`;
  const mac = crypto.createHmac('sha256', secret).update(msg).digest();
  const s = base32(mac).slice(0, 8);
  return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

// The elegant footer line printed on each page.
export function formatFooter({ iisNo, k, n, kid, seal }) {
  return ['EMB', iisNo, `p${k}/${n}`, `K${kid}`, seal].join(SEP);
}

const PARSE_RE =
  /EMB\s*·\s*([A-Z0-9-]+)\s*·\s*p(\d+)\/(\d+)\s*·\s*K([0-9A-Za-z]+)\s*·\s*([0-9A-Z]{4}-[0-9A-Z]{4})/;

// Parse a footer line (typed by staff or extracted from a page). Returns null if absent.
export function parseFooter(line) {
  const m = String(line ?? '').match(PARSE_RE);
  if (!m) return null;
  return { iisNo: m[1], k: Number(m[2]), n: Number(m[3]), kid: m[4], seal: m[5] };
}

// Constant-time string compare.
export function sealsEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
