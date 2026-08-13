// Compare OCR text from a photographed page against the authoritative page text.
//
// Pure — no I/O, no OCR engine, no PDF, no DB. Every judgment about what counts
// as a difference lives here, which is what makes it testable without
// photographing anything. See docs/superpowers/specs/2026-08-13-page-image-ocr-design.md
//
// This produces EVIDENCE, not proof. A clean result means "nothing found", not
// "verified" — only the seal verifies anything.

import { stripFooter } from './sealCode.js';

// Letter shapes OCR returns in place of digits. Folded toward the digit because
// no forger substitutes O for 0 — that is unambiguously the camera. Digit->digit
// is deliberately absent: we cannot tell "OCR misread 1 as 4" from "someone
// changed 1 to 4", so we never forgive it.
const GLYPH_FOLD = new Map([
  ['O', '0'], ['o', '0'], ['Q', '0'], ['D', '0'],
  ['l', '1'], ['I', '1'], ['|', '1'],
  ['S', '5'], ['B', '8'], ['Z', '2'], ['G', '6'],
]);

export function foldGlyphs(token) {
  return String(token ?? '')
    .split('')
    .map((ch) => GLYPH_FOLD.get(ch) ?? ch)
    .join('');
}

// Escapes, not literal characters, in both the fold and the tests that exercise
// it. A curly quote and an ASCII one are a pixel apart in most editors, so a
// literal cannot be reviewed by eye and does not survive being copied — the
// first implementation of this transcribed U+2018/U+2019 as ASCII apostrophes
// and weakened this test to straight quotes, and it passed against a dead fold.
const PUNCT_FOLD = [
  [/[\u2018\u2019\u201B]/g, "'"],
  [/[\u201C\u201D\u201F]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, '-'],
];

// No non-breaking-space rule: JS regex \s already matches U+00A0, and
// normalizeWords splits on /\s+/ below, so a fold for it would be
// unobservable \u2014 and therefore could never be regression-tested, which is
// exactly the property the rules above were just fixed to have.

// Lower-cased whitespace-separated words, footer removed. Case is folded because
// tamper detection does not turn on it and OCR case errors are common.
export function normalizeWords(text) {
  let s = stripFooter(String(text ?? ''));
  for (const [re, to] of PUNCT_FOLD) s = s.replace(re, to);
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

// Length of the longest common subsequence, Hirschberg-free: we only need the
// length, so two rolling rows are enough and memory stays O(min(n,m)).
function lcsLength(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let prev = new Array(short.length + 1).fill(0);
  let cur = new Array(short.length + 1).fill(0);
  for (let i = 1; i <= long.length; i++) {
    for (let j = 1; j <= short.length; j++) {
      cur[j] = long[i - 1] === short[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[short.length];
}

// 2*LCS / (|a| + |b|) — symmetric, so a photo that drops words and one that
// invents them are penalised alike.
export function similarity(a, b) {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * lcsLength(a, b)) / total;
}

const MONTH = 'January|February|March|April|May|June|July|August|September|October|November|December';

// Order matters: the first pattern to claim a span wins, so the more specific
// classes are listed before the looser ones. `name` is last because a run of
// capitals would otherwise swallow "Section 12" style citations.
const TOKEN_PATTERNS = [
  ['money', new RegExp(String.raw`(?:₱|PHP|P)\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?`, 'g')],
  ['date', new RegExp(String.raw`\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b|\b\d{1,2}\s+(?:${MONTH})\s+\d{4}\b|\b(?:${MONTH})\s+\d{1,2},\s*\d{4}\b`, 'gi')],
  ['duration', new RegExp(String.raw`\b\d+\s+(?:calendar\s+)?(?:day|days|month|months|year|years|week|weeks)\b`, 'gi')],
  ['reference', new RegExp(String.raw`\bR\d-\d{4}-\d{6}\b|\bNo\.\s?\d{2}-\d{3,6}\b`, 'g')],
  ['citation', new RegExp(String.raw`\b(?:Section|Sec\.|Rule|Article|Art\.)\s+(?:[IVXLC]+|\d+)\b`, 'gi')],
  ['name', new RegExp(String.raw`\b[A-Z][A-Z&.'-]+(?:\s+[A-Z][A-Z&.'-]+)+\b`, 'g')],
];

// Tokens the record carries that must survive in the photo, each tied to the
// line it sits on so a finding can point somewhere on the sheet.
export function extractTokens(text) {
  // stripFooter canonicalizes whitespace, which would destroy line structure —
  // so split first and strip the footer per line, keeping line numbers intact.
  const rawLines = String(text ?? '').split('\n');
  const out = [];
  const claimed = rawLines.map(() => []);

  for (const [cls, re] of TOKEN_PATTERNS) {
    rawLines.forEach((raw, i) => {
      const line = stripFooter(raw);
      // Blank out what earlier (more specific) classes already claimed, so a
      // greedy pattern cannot run straight through a claimed span. Masking
      // rather than discarding the whole match: "Rule III ACME MINING CORP"
      // used to lose ACME MINING CORP entirely, because III is itself matched
      // by the name class, so the run spanned the citation and the whole match
      // was dropped for overlapping it. (A citation WITH digits never collides:
      // the name pattern cannot cross them.)
      const masked = maskClaimed(line, claimed[i]);
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(masked)) !== null) {
        claimed[i].push([m.index, m.index + m[0].length]);
        out.push({ cls, value: m[0], line: i + 1 });
      }
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

// NUL, not a space: patterns match runs of whitespace, so a space mask would
// still be traversable — a name run would span a masked citation and capture
// the blanks with it. No pattern can cross a NUL.
const NUL = String.fromCharCode(0);

function maskClaimed(line, spans) {
  if (spans.length === 0) return line;
  const chars = line.split('');
  for (const [s, e] of spans) for (let j = s; j < e; j++) chars[j] = NUL;
  return chars.join('');
}

// PROVISIONAL — not yet calibrated against real photographs. Spec §9.2 requires
// these be measured on photographs of real printed pages before the feature is
// announced to staff; renders of the PDF are not admissible evidence for them.
// See docs/superpowers/plans/2026-08-13-page-image-ocr.md Task 8.
export const THRESHOLDS = {
  samePageMin: 0.6, // below this, the photo is not this page at all
  minWords: 20, // below this, OCR did not read enough to say anything
};

const STRICT = new Set(['money', 'date', 'duration', 'reference', 'citation']);

// Roman numerals in citations come back with the classic I/l/1 confusion, and
// without this fold every document citing a rule carries a standing false
// positive. Digits are untouched — a Roman numeral has none.
const ROMAN_FOLD = (s) => s.replace(/[l1|]/g, 'I').replace(/v/g, 'V');

function keyFor(cls, value) {
  const base = value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (cls === 'citation') return ROMAN_FOLD(base.toUpperCase()).toLowerCase();
  if (cls === 'name') return foldNameNoise(base);
  return foldGlyphs(base).replace(/^(?:php|p)\s?/, '₱');
}

// Tolerant classes: fold the confusions that dominate OCR of long words, so a
// name is only reported when it differs by more than the camera plausibly does.
function foldNameNoise(s) {
  return foldGlyphs(s).replace(/rn/g, 'm').replace(/cl/g, 'd').replace(/vv/g, 'w');
}

function digitsOf(s) {
  return (s.match(/\d/g) || []).join('');
}

// Why a strict token differs. Digit-count and digit-for-digit are ALWAYS
// material: we cannot distinguish a misread from an edit, and the two are not
// equally costly when wrong.
function reasonFor(expected, found) {
  const de = digitsOf(foldGlyphs(expected));
  const df = digitsOf(foldGlyphs(found));
  if (de.length !== df.length) return 'digit-count';
  if (de !== df) return 'digit-substitution';
  return 'text';
}

// Same principle as GLYPH_FOLD, applied to money's own pattern instead of a
// value already in hand. TOKEN_PATTERNS' money group requires \d, so a fully
// mangled reading like "₱5O,OOO.OO" only matches as far as "₱5" — the group
// and decimal quantifiers stop at the first letter. Loosened here for the OCR
// side only, never the record's: that text is machine text with no such noise
// to recover, and stays on the exact TOKEN_PATTERNS money pattern.
//
// The leading digit is left real (\d, not the lookalike class) on purpose: it
// is the anchor. Loosen it too and "CORPORATION" — P, then O, a lookalike —
// becomes a phantom money token in the middle of an ordinary name. Requiring
// a real digit right after the currency mark is what keeps "P" (a common
// letter on its own) from ever being mistaken for the start of an amount.
const DIGITISH = '0-9OoQDlI|SBZG';
const LOOSE_MONEY = new RegExp(
  String.raw`(?:₱|PHP|P)\s?\d[${DIGITISH}]{0,2}(?:,[${DIGITISH}]{3})*(?:\.[${DIGITISH}]{2})?`,
  'g'
);

function extractLooseMoney(text) {
  const rawLines = String(text ?? '').split('\n');
  const out = [];
  rawLines.forEach((raw, i) => {
    const line = stripFooter(raw);
    LOOSE_MONEY.lastIndex = 0;
    let m;
    while ((m = LOOSE_MONEY.exec(line)) !== null) {
      out.push({ cls: 'money', value: m[0], line: i + 1 });
    }
  });
  return out;
}

function indexByKey(tokens) {
  const m = new Map();
  for (const t of tokens) {
    const key = keyFor(t.cls, t.value);
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(t);
  }
  return m;
}

export function compare(ocrText, authText) {
  const ocrWords = normalizeWords(ocrText);
  const authWords = normalizeWords(authText);

  if (ocrWords.length < THRESHOLDS.minWords) {
    return { status: 'image_unreadable', similarity: 0, findings: [], suppressed: 0 };
  }

  const sim = similarity(ocrWords, authWords);
  if (sim < THRESHOLDS.samePageMin) {
    return { status: 'page_differs', similarity: sim, findings: [], suppressed: 0 };
  }

  const authTokens = extractTokens(authText);
  // Money is re-extracted with the loosened pattern above; every other class
  // comes from extractTokens as given. Both the truncated strict-pattern
  // match and the full loosened one would otherwise coexist here, and the
  // truncated leftover ("₱5") would then read as a phantom added value in
  // the photo->record pass below.
  const ocrTokens = extractTokens(ocrText)
    .filter((t) => t.cls !== 'money')
    .concat(extractLooseMoney(ocrText));
  const ocrByKey = indexByKey(ocrTokens);
  const authByKey = indexByKey(authTokens);

  const findings = [];
  let suppressed = 0;

  // Record -> photo. Did every value survive?
  for (const t of authTokens) {
    const key = keyFor(t.cls, t.value);
    const hit = ocrByKey.get(key);
    if (hit && hit.length) {
      hit.shift(); // consume, so duplicates pair up one-for-one
      continue;
    }
    const strict = STRICT.has(t.cls);
    // Nearest same-class token on the photo, to report WHAT it reads instead.
    const near = ocrTokens.find((o) => o.cls === t.cls && !authByKey.has(keyFor(o.cls, o.value)));
    if (!strict) {
      suppressed++;
      findings.push({
        severity: 'tolerant', cls: t.cls, line: t.line,
        expected: t.value, found: near ? near.value : null, reason: 'text',
      });
      continue;
    }
    findings.push({
      severity: 'material', cls: t.cls, line: t.line,
      expected: t.value,
      found: near ? near.value : null,
      reason: near ? reasonFor(t.value, near.value) : 'missing',
    });
  }

  // Photo -> record. Did the photo gain a value the record never had?
  for (const o of ocrTokens) {
    if (!STRICT.has(o.cls)) continue;
    const key = keyFor(o.cls, o.value);
    if (authByKey.has(key)) continue;
    if (findings.some((f) => f.found === o.value)) continue; // already paired above
    findings.push({
      severity: 'material', cls: o.cls, line: null,
      expected: null, found: o.value, reason: 'added',
    });
  }

  // Word-level differences not accounted for by any token finding are the
  // ordinary noise of reading paper. Counted, shown, not itemised as findings.
  const wordDiff = Math.max(authWords.length, ocrWords.length) - lcsLength(ocrWords, authWords);
  suppressed += Math.max(0, wordDiff - findings.length);

  const order = { material: 0, tolerant: 1 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || (a.line ?? 1e9) - (b.line ?? 1e9));

  return { status: 'compared', similarity: sim, findings, suppressed };
}
