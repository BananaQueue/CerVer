// Excludes a page's bottommost OCR'd line from comparison when it looks
// footer-shaped -- reference/citation content, never a money/date/duration
// value -- regardless of whether OCR preserved the footer's exact printed
// text shape. Position, not text, is the signal: a footer is always a
// page's last printed line, by construction.
//
// Pure. No I/O, no OCR engine. Reuses extractTokens (src/pageCompare.js,
// unmodified) as the content gate rather than reimplementing pattern
// matching. See docs/superpowers/specs/2026-08-24-ocr-footer-position-design.md

import { extractTokens } from './pageCompare.js';

const FOOTER_LIKE_CLASSES = new Set(['reference', 'citation']);
const STRICT_VALUE_CLASSES = new Set(['money', 'date', 'duration']);

// Escapes a word's text for use inside a RegExp alternation/sequence -- word
// text can legitimately contain '.', '(', etc. (real footer/reference
// punctuation), which must be matched literally, not as regex syntax.
function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Groups words into lines by vertical position. The tolerance is derived
// from the MEDIAN word height on this photo, not a fixed pixel count, so it
// adapts to whatever resolution/distance this particular capture used.
function clusterLines(words) {
  const usable = words.filter((w) => w?.text && w.text.trim() && w.bbox);
  if (usable.length === 0) return [];

  const heights = usable
    .map((w) => w.bbox.y1 - w.bbox.y0)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  if (heights.length === 0) return [];
  const medianHeight = heights[Math.floor(heights.length / 2)];
  const tolerance = medianHeight / 2;

  const withCenters = usable
    .map((w) => ({ word: w, center: (w.bbox.y0 + w.bbox.y1) / 2 }))
    .sort((a, b) => a.center - b.center);

  const lines = [];
  let current = [];
  let currentCenter = null;
  for (const { word, center } of withCenters) {
    if (current.length === 0) {
      current = [word];
      currentCenter = center;
      continue;
    }
    if (Math.abs(center - currentCenter) <= tolerance) {
      current.push(word);
      currentCenter = (currentCenter * (current.length - 1) + center) / current.length;
    } else {
      lines.push(current);
      current = [word];
      currentCenter = center;
    }
  }
  if (current.length > 0) lines.push(current);
  // Ascending by construction (sorted by center before clustering), so the
  // last line in this array is the bottommost -- the footer candidate.
  return lines;
}

export function stripOcrFooter(text, words) {
  const safeText = String(text ?? '');
  if (!Array.isArray(words) || words.length === 0) return safeText;

  const lines = clusterLines(words);
  if (lines.length === 0) return safeText;

  const candidate = lines[lines.length - 1];
  const candidateText = candidate.map((w) => w.text).join(' ');
  if (!candidateText.trim()) return safeText;

  const tokens = extractTokens(candidateText);
  const hasFooterLikeToken = tokens.some((t) => FOOTER_LIKE_CLASSES.has(t.cls));
  const hasStrictValueToken = tokens.some((t) => STRICT_VALUE_CLASSES.has(t.cls));
  if (!hasFooterLikeToken || hasStrictValueToken) return safeText;

  // Removal uses a flexible-whitespace pattern built from the same words,
  // rather than an exact substring match on candidateText -- Tesseract's own
  // flat text may not join words with a single space the way this function
  // does for the gate check above, and an exact-substring match that
  // silently fails to find anything would leave the footer un-removed with
  // no signal that anything went wrong.
  const pattern = new RegExp(candidate.map((w) => escapeForRegex(w.text)).join('\\s+'));
  return safeText.replace(pattern, '');
}
