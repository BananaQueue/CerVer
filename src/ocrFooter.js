// Excludes a line from the bottom of a page's OCR'd text from comparison
// when it looks footer-shaped -- reference/citation content, never a
// money/date/duration value -- regardless of whether OCR preserved the
// footer's exact printed text shape. Position, not text, is the signal: a
// footer is always printed near the bottom of the page, by construction.
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
  //
  // Each line's words are still in Y-sort order at this point, NOT reading
  // order -- real OCR words on the same visual line rarely share an exact
  // y-center (character height/baseline jitter), so grouping by Y silently
  // scrambles left-to-right order. Restored here, once, so every consumer
  // (the gate's joined text, and the removal pattern) gets correct reading
  // order without needing to know this was ever a risk.
  return lines.map((line) => [...line].sort((a, b) => a.bbox.x0 - b.bbox.x0));
}

// A trailing candidate must sit in the bottom quarter of the page's own
// vertical extent to be eligible at all -- proportional, not a fixed pixel
// or cluster count, so it adapts to any page length or photo resolution.
//
// A fixed CLUSTER COUNT was tried first and is wrong: real photos showed
// content genuinely below the footer text line (stray symbol fragments OCR
// read out of the pixelated seal-mark graphic printed near the stamp), so
// checking only the single bottommost cluster misses the real footer. But
// widening that to "the last few clusters" without any positional bound
// reaches all the way to a page's TOP line whenever the page is short or
// sparse -- caught by this plan's own test suite before it ever reached a
// real photo. Proportional position is what "near the footer" actually
// means; a cluster count was never the right unit for it.
const BOTTOM_BAND_FRACTION = 0.75;
// Secondary, cheap bound: even within the bottom band, only look at a few
// trailing clusters. Guards a degenerate near-zero vertical extent from
// putting the whole page "in the bottom band."
const MAX_TRAILING_CANDIDATES = 8;

export function stripOcrFooter(text, words) {
  const safeText = String(text ?? '');
  if (!Array.isArray(words) || words.length === 0) return safeText;

  const lines = clusterLines(words);
  if (lines.length === 0) return safeText;

  const allY = words.flatMap((w) => (w?.bbox ? [w.bbox.y0, w.bbox.y1] : []));
  const minY = Math.min(...allY);
  const maxY = Math.max(...allY);
  const bandStart = minY + BOTTOM_BAND_FRACTION * (maxY - minY);

  const lineCenter = (line) => {
    const centers = line.map((w) => (w.bbox.y0 + w.bbox.y1) / 2);
    return centers.reduce((a, b) => a + b, 0) / centers.length;
  };

  // Scan from the bottom upward, within the bottom band, and use the FIRST
  // line that passes the gate -- skipping past pure noise (a cluster with
  // no reference/citation token at all) without weakening the gate itself,
  // which still runs, unchanged, on every candidate examined.
  const trailing = lines
    .slice(-MAX_TRAILING_CANDIDATES)
    .reverse()
    .filter((line) => lineCenter(line) >= bandStart);

  for (const candidate of trailing) {
    const candidateText = candidate.map((w) => w.text).join(' ');
    if (!candidateText.trim()) continue;

    const tokens = extractTokens(candidateText);
    const hasFooterLikeToken = tokens.some((t) => FOOTER_LIKE_CLASSES.has(t.cls));
    const hasStrictValueToken = tokens.some((t) => STRICT_VALUE_CLASSES.has(t.cls));
    if (!hasFooterLikeToken || hasStrictValueToken) continue;

    return removeLine(safeText, candidate);
  }
  return safeText;
}

function removeLine(safeText, candidate) {
  // Removal uses a flexible-whitespace pattern built from the same words,
  // rather than an exact substring match on candidateText -- Tesseract's own
  // flat text may not join words with a single space the way this function
  // does for the gate check above, and an exact-substring match that
  // silently fails to find anything would leave the footer un-removed with
  // no signal that anything went wrong.
  const pattern = new RegExp(candidate.map((w) => escapeForRegex(w.text)).join('\\s+'));
  return safeText.replace(pattern, '');
}
