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
  [/\u00A0/g, ' '],
];

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
