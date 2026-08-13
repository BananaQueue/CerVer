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

  const overlaps = (spans, start, end) => spans.some(([s, e]) => start < e && end > s);

  for (const [cls, re] of TOKEN_PATTERNS) {
    rawLines.forEach((raw, i) => {
      const line = stripFooter(raw);
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (overlaps(claimed[i], start, end)) continue;
        claimed[i].push([start, end]);
        out.push({ cls, value: m[0], line: i + 1 });
      }
    });
  }
  return out.sort((a, b) => a.line - b.line);
}
