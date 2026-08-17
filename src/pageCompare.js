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
// unobservable — and therefore could never be regression-tested, which is
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

// Letter lookalikes for digits, as a regex character class rather than
// GLYPH_FOLD's single-character map. Defined here, ahead of TOKEN_PATTERNS,
// because the citation numeral below needs it to extract a mixed OCR reading
// (e.g. "1Z", "l2") as a token at all -- only then does keyFor's foldGlyphs
// get a chance to forgive it. LOOSE_MONEY just below reuses the same class
// for the same reason, on amounts instead of citations.
const DIGITISH = '0-9OoQDlI|SBZG';

// A citation numeral's digit-lookalike run must contain at least one of these
// to count as a numeral at all: a real digit, or the pipe OCR produces for a
// misread vertical stroke (never an ordinary English letter). Without this
// anchor, "Section OF", "Rule OB", "Article SB" and "Sec. GO" -- ordinary
// capitalised words that happen to be spelled entirely from DIGITISH's
// letters -- would each read as a phantom citation.
const CITATION_ANCHOR = '0-9|';

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

// Money used to be defined TWICE: a strict record-side entry inside
// TOKEN_PATTERNS (\d only, no structural filter) and a separate,
// independently-written OCR-side extractLooseMoney (DIGITISH-tolerant, with
// a filter). Each round of fixing one side left the other still disagreeing
// -- the record side matched "P1" in "P1M" with nothing to stop it, while the
// photo side's filter discarded the same construct outright; the record side
// stopped at \d{1,3} while the photo side's DIGITISH run absorbed a trailing
// unit letter and folded it into a digit. Both drifts produced material
// findings on a page compared against a perfect reading of itself. There is
// now exactly ONE definition, below, used for both sides: extractMoneyTokens,
// called directly by extractTokens for the record side and by compare() for
// the photo side. Nothing else decides what counts as a money token.
//
// Running the DIGITISH-tolerant pattern and its filter against record text
// (exact machine-extracted PDF text, no glyph-confusion noise) is safe: on
// clean text it produces the same matches a strict \d pattern would have,
// plus it now correctly handles a P-prefixed unit-letter or shorthand
// construct (P1M, P2P, P12B) appearing verbatim in the source, the same way
// on both sides.
//
// The leading digit is left real (\d, not the lookalike class) on purpose: it
// is the anchor. Loosen it too and "CORPORATION" — P, then O, a lookalike —
// becomes a phantom money token in the middle of an ordinary name. Requiring
// a real digit right after the currency mark is what keeps "P" (a common
// letter on its own) from ever being mistaken for the start of an amount.
//
// The two alternatives below are guarded differently because the currency
// mark decides the ambiguity, not a rule that can be shared across both.
//
// ₱ and PHP cannot occur inside an ordinary word — they need no start or
// trailing guard, and must keep the FULL amount even when OCR glues them to
// a neighbouring word with no space, e.g. "of₱50,000.00" or "₱50,000.00is",
// or "PHP 500was".
//
// Bare P is an ordinary letter and appears inside real words constantly
// (C0RP0RATI0N), so it keeps the start guard (?<![A-Za-z0-9]) against
// matching mid-word.
//
// A trailing guard against running into more letters used to live here too
// (first as a plain lookahead, then made atomic via (?=(x))\1 so a failure
// couldn't backtrack into a shorter, wrong reading -- see git history). Both
// versions rejected the WHOLE match whenever a letter followed with no space,
// which is exactly what a lost space between the amount and the next word
// looks like: "P50,000.00is" (should read the full amount) came back
// indistinguishable from "P0LLUTI0N" (should never read as an amount at
// all) -- one false positive relabelled as another (missing instead of
// digit-count), never actually fixed.
//
// The two ARE distinguishable, just not by "what comes after" -- by what the
// digit run itself looks like. A misread ordinary word never produces a
// thousands-separator comma or a decimal point in the middle of its
// digit-lookalike run; a real amount routinely does. So the regex itself
// takes the full greedy AMOUNT unconditionally (same as ₱/PHP -- nothing
// left here that can backtrack, since there is no trailing assertion to
// fail), and extractMoneyTokens below applies the letters-immediately-follow
// check as a JS-level structural filter instead: keep the match if nothing
// but a letter follows AND it has a comma or a decimal (it reads as a real
// amount that lost its trailing space); discard it otherwise (it reads as
// digit-lookalike noise inside a word, same as the guard always intended).
//
// isBareP tests the currency MARK, not the first character of the match: a
// PHP-prefixed match also starts with the letter 'P' ("PHP 500"[0] === 'P'),
// so a single-character check misclassified every PHP amount as bare-P and
// subjected it to the bare-P filter above -- a PHP amount that lost a space
// to OCR ("PHP 500was") was wrongly discarded instead of kept whole, the
// same false positive this whole filter exists to prevent.
const AMOUNT = String.raw`\d[${DIGITISH}]{0,2}(?:,[${DIGITISH}]{3})*(?:\.[${DIGITISH}]{2})?`;
const LOOSE_MONEY = new RegExp(
  String.raw`(?:₱|PHP)\s?${AMOUNT}`
    + '|'
    + String.raw`(?<![A-Za-z0-9])P\s?${AMOUNT}`,
  'g'
);

// The one place that decides what counts as a money token, for both record
// and photo text. `claimed` is the same per-line array extractTokens uses for
// every other class, so money masks correctly relative to them in both
// directions: money runs first (see extractTokens), so it never eats a span
// another class already claimed (nothing is claimed yet), and it pushes its
// own spans into `claimed` so later classes cannot run through a money match.
function extractMoneyTokens(text, claimed) {
  const rawLines = String(text ?? '').split('\n');
  const out = [];
  rawLines.forEach((raw, i) => {
    const line = stripFooter(raw);
    const masked = maskClaimed(line, claimed[i]);
    LOOSE_MONEY.lastIndex = 0;
    let m;
    while ((m = LOOSE_MONEY.exec(masked)) !== null) {
      const end = m.index + m[0].length;
      const nextChar = masked[end];
      const isBareP = !(m[0].startsWith('₱') || m[0].startsWith('PHP'));
      const gluedToNextWord = nextChar !== undefined && nextChar !== NUL && /[A-Za-z]/.test(nextChar);
      const readsAsRealAmount = /[,.]/.test(m[0]); // thousands separator or decimal
      if (isBareP && gluedToNextWord && !readsAsRealAmount) continue;
      claimed[i].push([m.index, end]);
      out.push({ cls: 'money', value: m[0], line: i + 1 });
    }
  });
  return out;
}

// Order matters: the first pattern to claim a span wins, so the more specific
// classes are listed before the looser ones. `name` is last because a run of
// capitals would otherwise swallow "Section 12" style citations. Money is not
// in this list at all -- extractTokens runs extractMoneyTokens first, ahead
// of this loop, so it still claims first exactly as it did when it was the
// first entry here.
//
// The numeral accepts a pure Roman-numeral run (unchanged) or a DIGITISH run
// anchored by at least one real digit or pipe, so a mixed OCR reading like
// "Section 1Z" or "Rule |||" is extracted as a citation token and folded like
// money already is -- see docs/superpowers/specs/2026-08-13-page-image-ocr-design.md
// 5.4. The trailing boundary is a negative lookahead rather than \b: \b needs
// a word/non-word transition, but a match ending in "|" (non-word on both
// sides against a following space) has no such transition, so \b would wrongly
// reject "Rule |||" even though nothing follows it.
const CITATION_NUMERAL = String.raw`[IVXLC]+|(?=[${DIGITISH}]*[${CITATION_ANCHOR}])[${DIGITISH}]+`;
const TOKEN_PATTERNS = [
  ['date', new RegExp(String.raw`\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b|\b\d{1,2}\s+(?:${MONTH})\s+\d{4}\b|\b(?:${MONTH})\s+\d{1,2},\s*\d{4}\b`, 'gi')],
  ['duration', new RegExp(String.raw`\b\d+\s+(?:calendar\s+)?(?:day|days|month|months|year|years|week|weeks)\b`, 'gi')],
  ['reference', new RegExp(String.raw`\bR\d-\d{4}-\d{6}\b|\bNo\.\s?\d{2}-\d{3,6}\b`, 'g')],
  ['citation', new RegExp(String.raw`\b(?:Section|Sec\.|Rule|Article|Art\.)\s+(?:${CITATION_NUMERAL})(?![A-Za-z0-9])`, 'gi')],
  ['name', new RegExp(String.raw`\b[A-Z][A-Z&.'-]+(?:\s+[A-Z][A-Z&.'-]+)+\b`, 'g')],
];

// Tokens the record carries that must survive in the photo, each tied to the
// line it sits on so a finding can point somewhere on the sheet. Also the
// entry point the photo side uses (see compare(), below) -- money, and every
// other class, is extracted identically for both.
export function extractTokens(text) {
  // stripFooter canonicalizes whitespace, which would destroy line structure —
  // so split first and strip the footer per line, keeping line numbers intact.
  const rawLines = String(text ?? '').split('\n');
  const out = [];
  const claimed = rawLines.map(() => []);

  // Money first, same position it held inside TOKEN_PATTERNS before it moved
  // out to get its own structural filter -- see extractMoneyTokens above.
  out.push(...extractMoneyTokens(text, claimed));

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

// PROVISIONAL — not yet calibrated against real photographs. Spec §9.2 requires
// these be measured on photographs of real printed pages before the feature is
// announced to staff; renders of the PDF are not admissible evidence for them.
// See docs/superpowers/plans/2026-08-13-page-image-ocr.md Task 8.
export const THRESHOLDS = {
  samePageMin: 0.6, // below this, the photo is not this page at all
  minWords: 20, // below this, OCR did not read enough to say anything
};

const STRICT = new Set(['money', 'date', 'duration', 'reference', 'citation']);

// Citations no longer need a special-cased Roman-numeral fold: GLYPH_FOLD
// already maps I, l and | to '1', so folding before lowercasing (below)
// makes foldGlyphs('Rule III') and foldGlyphs('Rule Ill') identical on the
// ordinary key path. A dedicated ROMAN_FOLD used to be applied here, but it
// ran on an already-uppercased string against a pattern that only matched
// lowercase l/v, so it was a no-op — removed rather than fixed in place.
function keyFor(cls, value) {
  const collapsed = String(value).replace(/\s+/g, ' ').trim();
  if (cls === 'name') return foldNameNoise(collapsed.toLowerCase());
  // Fold before lowercasing, not after: GLYPH_FOLD's B, D, Q, S, Z, G entries
  // are uppercase-only (no lowercase counterpart), so folding a
  // pre-lowercased string leaves six of the map's eight letter rules dead.
  // Folding the original-case value first keeps every entry live.
  return foldGlyphs(collapsed).toLowerCase().replace(/^(?:php|p)\s?/, '₱');
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

  // Both sides now go through the exact same extractTokens -- including for
  // money, which used to be re-extracted here with a second, independently
  // written pattern. That second definition is what let the record and photo
  // sides disagree about what counts as an amount; there is nothing left here
  // to keep in sync.
  const authTokens = extractTokens(authText);
  const ocrTokens = extractTokens(ocrText);
  const ocrByKey = indexByKey(ocrTokens);
  const authByKey = indexByKey(authTokens);

  const findings = [];
  let suppressed = 0;

  // Photo tokens already attributed to a record-side finding as `near`
  // below, keyed by object identity so the photo -> record pass does not
  // also report the same token as an unexplained addition.
  const consumedNear = new Set();

  // Record -> photo. Did every value survive?
  for (const t of authTokens) {
    const key = keyFor(t.cls, t.value);
    const hit = ocrByKey.get(key);
    if (hit && hit.length) {
      hit.shift(); // consume, so duplicates pair up one-for-one
      continue;
    }
    const strict = STRICT.has(t.cls);
    // Nearest same-class, still-unclaimed token on the photo (by line
    // distance), to report WHAT it reads instead. Consumed on selection so
    // two record tokens can never both claim the same photo token — taking
    // the first unmatched one in document order, un-consumed, let an earlier
    // record token steal the photo token a later one actually corresponds
    // to, fabricating both the value and the reason it reported.
    let near = null;
    let bestDist = Infinity;
    for (const o of ocrTokens) {
      if (o.cls !== t.cls) continue;
      if (consumedNear.has(o)) continue;
      if (authByKey.has(keyFor(o.cls, o.value))) continue;
      const dist = Math.abs(o.line - t.line);
      if (dist < bestDist) {
        bestDist = dist;
        near = o;
      }
    }
    if (near) consumedNear.add(near);
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

  // Photo -> record. Did the photo gain a value the record never had? Consumes
  // from authByKey the same way the pass above consumes from ocrByKey, so a
  // photo token repeated more times than the record carries it is reported —
  // testing presence alone (`.has`) let a duplicated amount hide behind the
  // single genuine occurrence and produce no finding at all.
  for (const o of ocrTokens) {
    if (!STRICT.has(o.cls)) continue;
    if (consumedNear.has(o)) continue; // already paired above
    const key = keyFor(o.cls, o.value);
    const hit = authByKey.get(key);
    if (hit && hit.length) {
      hit.shift();
      continue;
    }
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
