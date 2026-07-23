// Pure resolution of any QR payload / typed input into a canonical lookup key.
// This is the ONE place that absorbs the format variance across document types:
//   Special Order      R1-2025-028799            (bare IIS no.)
//   Travel Order       EMBR1-2025-030436         (EMB-prefixed -> canonical R1-...)
//   Accomplishment Rpt 13081688c1eb0a6ab8-...    (long hash token)
//   any                https://iis.emb.gov.ph/embis/dar/preview2/{token}

const IIS_RE = /\b(?:EMB)?(R1)-((?:19|20)\d\d)-(\d{4,})\b/i;

/**
 * @param {string} payload
 * @returns {{ raw: string, kind: 'iis_no'|'token'|'unknown', canonicalId: string, lookupKey: string }}
 */
export function normalize(payload) {
  const raw = payload == null ? '' : String(payload);
  const s = raw.trim();

  // For URLs, first try to pull an IIS number from anywhere in the URL;
  // otherwise fall back to the last non-empty path segment as a token.
  let candidate = s;
  if (/^https?:\/\//i.test(s)) {
    const iisInUrl = s.match(IIS_RE);
    if (iisInUrl) {
      candidate = iisInUrl[0];
    } else {
      const segs = s.split('?')[0].split('#')[0].split('/').filter(Boolean);
      candidate = segs.length ? segs[segs.length - 1] : '';
    }
  }

  const m = candidate.match(IIS_RE);
  if (m) {
    const canonicalId = `${m[1].toUpperCase()}-${m[2]}-${m[3]}`;
    return { raw, kind: 'iis_no', canonicalId, lookupKey: canonicalId };
  }

  if (candidate && candidate.length >= 12 && /[a-f0-9]{8,}/i.test(candidate)) {
    return { raw, kind: 'token', canonicalId: candidate, lookupKey: candidate };
  }

  const trimmed = candidate.trim();
  if (!trimmed) return { raw, kind: 'unknown', canonicalId: '', lookupKey: '' };
  return { raw, kind: 'unknown', canonicalId: trimmed, lookupKey: trimmed };
}
