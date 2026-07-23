// HMAC seal secrets. NEVER stored in the DB. Loaded from env as JSON {kid: secret}.
// A `kid` (key id) travels in each printed code so keys can be rotated: add a new
// kid, keep old ones so previously sealed documents still verify.

function loadKeys() {
  const raw = process.env.CERVER_SEAL_KEYS;
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && Object.keys(obj).length) return obj;
    } catch {
      // fall through to dev default
    }
  }
  // Dev-only default so the app runs out of the box. Set CERVER_SEAL_KEYS in prod.
  return { 1: 'dev-insecure-seal-key-change-me' };
}

const KEYS = loadKeys();

export function currentKid() {
  // Highest numeric kid wins as the "current" signing key.
  return Object.keys(KEYS)
    .sort((a, b) => Number(a) - Number(b))
    .pop();
}

export function secretFor(kid) {
  const s = KEYS[kid];
  if (!s) throw new Error(`No seal secret for kid ${kid}`);
  return s;
}

export function keyProvider() {
  return { currentKid, secretFor };
}
