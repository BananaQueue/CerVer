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
  ['l', '1'], ['I', '1'], ['|', '1'], ['t', '1'], ['i', '1'],
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

// reference's own extraction class, DIGITISH plus 't' and 'i' -- real
// misreads (2026-08-24: "R1-2026-010734" -> "Rt-2026-010734"; 2026-08-27:
// "R1-2026-001024" -> "Ri-2026-001024") not covered by GLYPH_FOLD's other
// six letters, which are the classic OCR digit lookalikes (O/0, l/1, S/5,
// B/8, Z/2, G/6). Neither 't' nor 'i' is one of those, so both are kept
// out of the shared DIGITISH used by money and citation -- widening it
// there was never reviewed for those classes and isn't needed to fix this.
const REFERENCE_DIGITISH = `${DIGITISH}ti`;

// The hyphens inside a reference code are structural, not digit content --
// forgiving what character reads there costs nothing security-wise, since
// the value the digit rule protects is the digit groups, not the
// punctuation style between them. Two real misreads, both 2026-08-27: a
// tilde ("R1-2026-001024" -> "Rl~2026-001024") and an equals sign
// ("R1-2026-001024" -> "Ri=2026-001024", the same photo that also misread
// the '1' as 'i' -- see REFERENCE_DIGITISH). Either was invisible to
// extraction the same way the 't' misread was until REFERENCE_DIGITISH
// covered it. The em/en-dash range is the same one PUNCT_FOLD already
// treats as a dash elsewhere in this file -- kept as its own constant
// rather than folded into PUNCT_FOLD, which also feeds the whole-page
// similarity check and other classes' literal em-dash content (e.g.
// "Category B — Environmentally Critical Area"); this widening is reviewed
// for reference only.
const REFERENCE_SEP = '[-\\u2010-\\u2015\\u2212~=]';

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
// The BARE-P alternative's leading digit is left real (\d, not the lookalike
// class) on purpose: it is the anchor. Loosen it and "CORPORATION" — P, then
// O, a lookalike — becomes a phantom money token in the middle of an ordinary
// name. Requiring a real digit right after a bare P is what keeps "P" (a
// common letter on its own) from ever being mistaken for the start of an
// amount.
//
// The ₱/PHP alternative does NOT carry that anchor, and must not: the anchor
// buys those marks nothing (neither can occur mid-word, so there is no
// ordinary word to protect) while costing them spec §5.4's letter-for-digit
// forgiveness at the FIRST digit position alone — "₱S00.00" was not extracted
// as an amount at all and the record's ₱500.00 reported as `missing`, even
// though the identical noise at every LATER position ("₱5O,OOO.OO") was
// already forgiven. The two branches' leading rules are deliberately
// different; only the mark branch is loose.
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
// digit run itself looks like. So the regex itself takes the full greedy
// amount() unconditionally (same as ₱/PHP -- nothing left here that can
// backtrack, since there is no trailing assertion to fail), and
// extractMoneyTokens below applies the letters-immediately-follow check as a
// JS-level structural filter instead. See gluedReadsAsAmount for what that
// filter now tests, and why "does the match contain a comma or a decimal"
// -- its first form -- was not enough.
//
// isBareP tests the currency MARK, not the first character of the match: a
// PHP-prefixed match also starts with the letter 'P' ("PHP 500"[0] === 'P'),
// so a single-character check misclassified every PHP amount as bare-P and
// subjected it to the bare-P filter above -- a PHP amount that lost a space
// to OCR ("PHP 500was") was wrongly discarded instead of kept whole, the
// same false positive this whole filter exists to prevent.
//
// The digit run accepts thousands grouping but does NOT require it. Requiring
// it (the run was `\d[D]{0,2}(?:,[D]{3})*`) meant a comma-less run was cut
// off after three digits, which produced BOTH halves of the same defect:
// "₱50000.00", an ordinary dropped-comma misreading, truncated to "₱500" and
// was reported as `digit-count` -- the loudest label the feature has -- on an
// untouched page; and "₱10009" against a record's "₱10000" truncated to the
// same "₱100" on both sides, hiding a real edit completely. The separator is
// [,.] rather than "," because OCR reads a comma as a period constantly, and
// spec §5.4 requires separators be unified, not merely tolerated -- keyFor
// strips them (see THOUSANDS_SEP) so the grouped and ungrouped spellings of
// the same number key alike.
const GROUPED = String.raw`[${DIGITISH}]{0,2}(?:[,.][${DIGITISH}]{3})+`;
const UNGROUPED = String.raw`[${DIGITISH}]*`;
// Accepts either separator, same as GROUPED and for the same reason: OCR
// reads a comma as a period and a period as a comma with about equal
// frequency. This used to accept only '.', which forgave the period-for-comma
// misread on the THOUSANDS group (via GROUPED, above) but not the
// comma-for-period misread here on the CENTAVOS group -- "₱50,000.00" read as
// "₱50,000,00" truncated the match at the thousands group entirely (the
// centavos ",00" had nothing left in the pattern that could claim it) and
// reported `digit-count`, the loudest label the feature has, on an untouched
// page. keyFor normalizes whichever separator survives here back to '.' (see
// below) so both spellings key alike, the same way THOUSANDS_SEP does for the
// grouped separator.
const CENTAVOS = String.raw`(?:[,.][${DIGITISH}]{2})?`;
// `first` is the leading character class: real-digit-only for bare P (the
// CORPORATION anchor), lookalike-tolerant for ₱/PHP (spec §5.4 forgiveness).
const amount = (first) => `${first}(?:${GROUPED}|${UNGROUPED})${CENTAVOS}`;
// The currency MARK is case-insensitive, so "Php" -- the conventional
// Philippine spelling -- is recognised at all. Without this a tampered amount
// on a Php-marked page produced NO token on either side and so could never be
// flagged, whatever it was changed to.
//
// Spelled out per character rather than with the `i` flag date, duration and
// citation carry. The flag would also apply to DIGITISH, which enumerates its
// cases deliberately ('O' and 'o', 'l' and 'I') -- under `i` it silently gains
// lowercase d, s, b, z, g, q and uppercase L, none of which GLYPH_FOLD can
// fold back. Measured, not assumed: with the flag on, "₱50,000.00is" absorbed
// the trailing "is" into the amount and keyed as ₱50000001, and "P500due"
// absorbed the "d" and was then thrown out by the glue filter -- two of the
// false positives this file has already been fixed for, reintroduced by the
// flag. The leading guard (?<![A-Za-z0-9]) is case-blind either way.
const LOOSE_MONEY = new RegExp(
  String.raw`(?:₱|[Pp][Hh][Pp])\s?${amount(`[${DIGITISH}]`)}`
    + '|'
    + String.raw`(?<![A-Za-z0-9])[Pp]\s?${amount('\\d')}`,
  'g'
);

// A registration-fee amount spelled in words then repeated numerically in
// parentheses -- the standard convention in these documents ("THREE HUNDRED
// FIFTY PESOS (₱350.00)"). Real case, 2026-09-07: a photo's OCR dropped the
// currency mark entirely ("PESOS (350.00)", no ₱ or P anywhere), and with no
// mark to anchor either branch of LOOSE_MONEY the amount vanished from
// extraction completely -- the record's real, untouched fee reported
// material "missing" on a genuine page.
//
// Anchored on the literal word PESOS(S) immediately before the parenthesis,
// not a bare digit run on its own -- a bare number in parentheses is far too
// common elsewhere (list numbering, cross-references, dates) to extract
// safely without that anchor. Group 1 captures only the digit run; the mark
// is synthesized back on in extractMoneyTokens below, since keyFor already
// expects one and this branch only ever fires once "PESOS(" has confirmed
// the digits really are an amount.
//
// The optional [^\d\s)₱Pp] right after the parenthesis tolerates one stray
// character standing in for the mark, not just its outright absence. Real
// case, 2026-09-07, a different photo of the same document: OCR didn't drop
// the mark, it substituted it -- "PESOS (£350.00)", a pound sign where the
// peso sign should be. Neither the ₱/PHP/bare-P branches above (which need
// a real currency letter/mark) nor a digit run starting immediately after
// "(" matched a pound sign sitting in between, so this amount vanished too.
// ₱ and P/p are excluded from the tolerated character specifically so this
// can never double-match what LOOSE_MONEY already extracts correctly on its
// own -- if the stray slot matched those too, "PESOS (₱350.00)" would
// produce two money tokens for the same amount instead of one.
const PESOS_PAREN = new RegExp(
  String.raw`\bPESOS?\s*\(\s*[^\d\s)₱Pp]?\s*(${amount(`[${DIGITISH}]`)})\s*\)`,
  'gi',
);

// "PESOS" (or "PESO") itself hyphenated across a print line-wrap -- real
// case, 2026-09-07, a different photo of the same document again: justified
// print broke the word at the right margin ("...FIFTY PE-" / "SOS
// (450.00)..."). PESOS_PAREN matches within one line, so neither line
// contains the whole word and the amount vanished from extraction entirely.
// That photo's material verdict still came out right, by coincidence -- the
// record's own value simply had nothing to match -- but the same break on a
// genuine, untouched photo would misfire identically.
//
// Checked only when line i ends in a short hyphenated fragment; the tail
// and the next line's head must reconstruct exactly PESOS or PESO before
// anything else is attempted, so an unrelated hyphenated word (e.g.
// "MANAGE-" / "MENT") can never trigger this.
function dehyphenatedPesosMatch(prevLine, line) {
  const tail = /([A-Za-z]{1,4})-\s*$/.exec(prevLine);
  if (!tail) return null;
  const head = /^\s*([A-Za-z]{1,4})\b/.exec(line);
  if (!head) return null;
  const joined = (tail[1] + head[1]).toUpperCase();
  if (joined !== 'PESOS' && joined !== 'PESO') return null;
  const restStart = head.index + head[0].length;
  const rest = line.slice(restStart);
  const m = new RegExp(
    String.raw`^\s*\(\s*[^\d\s)₱Pp]?\s*(${amount(`[${DIGITISH}]`)})\s*\)`,
    'i',
  ).exec(rest);
  if (!m) return null;
  return { value: `₱${m[1]}`, start: restStart, end: restStart + m[0].length };
}

// Does a bare-P match that runs straight into a letter read as a real amount
// that lost its trailing space, or as digit-lookalike noise inside a misread
// word? Three signals, each closing a case the others do not:
//
//   - a comma/period separator or a decimal point in the run. A misread word
//     never produces one; a real amount routinely does. This alone was the
//     whole filter, and it discarded every amount under 1,000 written without
//     centavos -- "P500due" -- which is how fees and small fines are actually
//     written. Both directions were wrong: the glued side lost the token, so
//     the same page read `missing` one way and `added` the other.
//   - every character of the run is a REAL digit. A lookalike LETTER in the
//     run means the run came out of a word ("P0LL" from P0LLUTI0N, "PD" from
//     PDF), not off a printed amount.
//   - the run is two or more digits and does not start with 0. Printed
//     amounts carry no leading zero, and a single digit glued to a word is
//     far likelier to be noise than money. Without these two, "P0LLUTI0N"
//     (run "0") and "P1PELINE" (PIPELINE with the I misread, run "1") each
//     read as a phantom amount again -- the exact false-positive class this
//     filter exists for, reopened by the digits-only test on its own.
function gluedReadsAsAmount(match) {
  if (/[,.]/.test(match)) return true;
  const run = match.replace(/^[Pp]\s?/, '');
  return /^[1-9]\d+$/.test(run);
}

// A match with no genuine digit anywhere in it is not an amount. The ₱/PHP
// branch's leading character is digit-lookalike-tolerant (spec §5.4 --
// forgives "₱S00.00") and the amount pattern allows a zero-length remainder
// after that one character, so the mark plus a SINGLE lookalike letter, with
// nothing that is actually 0-9 anywhere in the match, was itself accepted as
// a complete "amount" -- "PHP Section 12" read as money token "PHP S", eating
// the leading letter of "Section" before citation extraction ever ran and
// hiding a tampered citation number completely behind it. The bare-P branch
// already anchors its first character on a real \d, so a genuine digit always
// exists there and this is a no-op for it; it only bites the mark branch,
// which has no anchor of its own to lose. Keep the lookalike-tolerant leading
// character -- do not remove it, "₱5O,OOO.OO" still needs it -- this only
// rejects a match that is lookalike letters through and through.
//
// But requiring a real 0-9 over-corrected: an amount whose digits are ALL
// glyph lookalikes -- "1"->"l", every "0"->"O", e.g. "₱l,OOO.OO" for
// "₱1,000.00" -- has no real digit either, and vanished from extraction
// entirely instead of being forgiven, reporting a material "missing" finding
// on an untampered page. What actually distinguishes a genuine (if badly
// misread) amount from the phantom is not "does it contain a real digit" --
// it's amount *structure*. A genuine amount carries a comma or period in the
// grouping the GROUPED/CENTAVOS patterns already enforce; the phantom ("PHP
// S", "PHP O") never does, because it is just the mark plus one bare letter
// with nothing else. So a comma or period is accepted as proof of a real
// amount too: a genuine amount's separator survives glyph-lookalike noise
// even when every digit doesn't, making structure the more reliable signal
// than any single digit.
function hasRealDigit(match) {
  return /\d/.test(match) || /[,.]/.test(match);
}

// A citation's own analogue to hasRealDigit, applied only to the 'added'
// pass (compare(), below) -- not to extraction. CITATION_ANCHOR deliberately
// accepts a lone "|" as sufficient evidence to extract a token AT ALL, so
// that "Rule III" misread as "Rule |||" still folds against an EXISTING
// record citation (see the "Rule ||| (lookalike-only) is not a finding"
// test) -- removing that at extraction would break the fold path along with
// the phantom. But when a citation token has NO record counterpart to fold
// against, the same lone "|" has nothing behind it at all. Real case,
// 2026-09-09: a live photo read a stray artifact right after an ordinary,
// non-citation use of the word "Section" ("...Assessment Section", a job
// title) as "Section |" -- material "document altered" finding on a
// genuine page. A citation is trustworthy evidence of an addition only when
// it carries a real digit, or is a genuine Roman-numeral spelling (never
// built from DIGITISH lookalikes alone, since [IVXLC]+ contains no digit
// lookalikes outside actual Roman-numeral letters).
function citationHasRealEvidence(value) {
  const numeral = String(value ?? '').replace(/^(?:Section|Sec\.|Rule|Article|Art\.)\s+/i, '');
  return /^[IVXLC]+$/i.test(numeral) || /\d/.test(numeral);
}

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
      // Case-insensitive, because the pattern now is: "Php 500"[0] === 'P'
      // reads as bare P under a case-sensitive check, and would then be put
      // through the bare-P glue filter it must never see.
      const isBareP = !/^(?:₱|php)/i.test(m[0]);
      const gluedToNextWord = nextChar !== undefined && nextChar !== NUL && /[A-Za-z]/.test(nextChar);
      // A bare-P match immediately followed by "/digit" is a page indicator
      // ("p2/2", "p1/3" -- the footer stamp format used throughout this
      // project), never a real amount: no printed amount is ever followed
      // by a slash and another digit. Real case, 2026-08-27: a footer whose
      // reference token failed to extract left the whole line unstripped
      // (the content gate that would have removed it requires a reference
      // AND zero money tokens -- see docs/superpowers/specs), and "p2" from
      // "p2/2" was read as a phantom bare-P amount as a result. This guard
      // closes that independently of whether the reference extracts.
      const isPageIndicator = isBareP && /^\/\d/.test(masked.slice(end, end + 2));
      if (!hasRealDigit(m[0])) continue;
      if (isPageIndicator) continue;
      if (isBareP && gluedToNextWord && !gluedReadsAsAmount(m[0])) continue;
      claimed[i].push([m.index, end]);
      out.push({ cls: 'money', value: m[0], line: i + 1 });
    }
    PESOS_PAREN.lastIndex = 0;
    let p;
    while ((p = PESOS_PAREN.exec(masked)) !== null) {
      const value = `₱${p[1]}`;
      if (!hasRealDigit(value)) continue;
      claimed[i].push([p.index, p.index + p[0].length]);
      out.push({ cls: 'money', value, line: i + 1 });
    }
    if (i > 0) {
      const prevLine = maskClaimed(stripFooter(rawLines[i - 1]), claimed[i - 1]);
      const dh = dehyphenatedPesosMatch(prevLine, masked);
      if (dh && hasRealDigit(dh.value)) {
        claimed[i].push([dh.start, dh.end]);
        out.push({ cls: 'money', value: dh.value, line: i + 1 });
      }
    }
  });
  return out;
}

// A "Label : Value" line -- see docs/superpowers/specs/
// 2026-08-25-labeled-field-comparison-design.md. Not a TOKEN_PATTERNS entry:
// each match's identity comes from what it captures (a single fixed 'field'
// class, not one class per label -- the record/photo value pair a finding
// already shows makes which field it is obvious in context), the same
// reason money gets its own extraction function instead of a pattern entry.
//
// This is the RECORD-side shape only now (real PDF text, never garbled).
// Both groups are captured: label (1) feeds compare()'s field-label
// collection, value (2) becomes the token. A first version tried this same
// blind pattern on both sides and failed real-photo verification -- the
// colon itself turned out not to be a reliable anchor at all (dropped
// entirely, or misread as "+", on real genuine photos), not just noisy
// around its edges. See §2a of the design doc for the four real shapes
// that sank that version.
const FIELD_LINE = /^\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\s*[-_.\s]{0,10}:\s*(.+?)\s*$/;

// Whatever survives between a known label and its value on a real photo,
// once the colon itself can no longer be trusted to be there: a genuine
// colon, a misread substitute, or nothing but whitespace where one used to
// be. The em-dash/en-dash range is the same one PUNCT_FOLD already treats
// as a dash elsewhere in this file.
const FIELD_SEP = new RegExp('^[\\s:;+_.\\-\\u2010-\\u2015\\u2212]*');

// Runs after every other class, including 'name' inside the TOKEN_PATTERNS
// loop below -- see extractTokens, which calls this last. If a value is an
// ALL-CAPS run 'name' already claimed (a company name, say), the matched
// span is NUL-masked by the time this sees it; rather than emit a token
// built from masked characters, this bails on the whole line and leaves the
// value as the name token it already became. A shape this can't cleanly
// use is invisible to it, not an error -- same fail-safe posture as every
// other extraction function in this file.
//
// knownLabels, when supplied, is the record's own set of field labels
// (compare() collects these from the record side and passes them in for
// the photo side only) -- see the design doc §3. A label match anchors on
// the label itself, not on whatever punctuation follows it, which is what
// makes this immune to the colon being dropped or misread. Without
// knownLabels (record side, or any caller working on a single string in
// isolation), only the blind FIELD_LINE shape is available.
function extractFieldTokens(text, claimed, knownLabels) {
  const rawLines = String(text ?? '').split('\n');
  const out = [];
  rawLines.forEach((raw, i) => {
    const line = stripFooter(raw);
    const masked = maskClaimed(line, claimed[i]);
    let value = null;
    let start = -1;
    let label = null;
    if (knownLabels) {
      // Searches the whole line, not just its start: a real photo (1-altered.jpg,
      // 2026-08-25) read stray marks before the label itself ('"i Proponent
      // —_: ...'), which an anchored startsWith would never tolerate. Word
      // boundary required after -- 'Project' must not match inside
      // 'Projections' -- and nothing that reads as a real word (2+ letters)
      // allowed before: a genuine label line's only pre-label noise is a
      // stray misread mark (a lone letter, punctuation), never a real word.
      // Found immediately after the whole-line search was added: without
      // this, 'The Proponent shall implement...' (ordinary prose, not a
      // field line) matched 'Proponent' too, fabricating a phantom field
      // from the rest of that sentence.
      for (const candidateLabel of knownLabels) {
        const idx = masked.indexOf(candidateLabel);
        if (idx === -1) continue;
        if (/[a-zA-Z]{2,}/.test(masked.slice(0, idx))) continue;
        const after = masked[idx + candidateLabel.length];
        if (after !== undefined && /[a-zA-Z]/.test(after)) continue;
        const rest = masked.slice(idx + candidateLabel.length).replace(FIELD_SEP, '');
        const candidate = rest.replace(/\s+$/, '');
        if (candidate && !candidate.includes(NUL)) {
          value = candidate;
          label = candidateLabel;
          start = masked.indexOf(candidate, idx + candidateLabel.length);
          break;
        }
      }
    }
    // Only the record side (no knownLabels -- it's the source of labels,
    // not a consumer of them) falls back to the blind pattern. Real photo,
    // 2026-08-27 (1-genuine.jpg, "Special Order" fixture set): a misread of
    // the seal/logo glyphs bleeding into the letterhead line read as
    // "NE: 5 Republic of the Philippines" -- a genuine photo, zero real
    // alterations. Falling back to the blind pattern here treated that OCR
    // noise as a brand-new field the record never had, reporting it
    // "added." The known-label loop above already tried every real label
    // and found none on this line; there is nothing left to anchor a photo-
    // side match to, so the line is left unmatched rather than guessed at.
    if (value === null && !knownLabels) {
      const m = FIELD_LINE.exec(masked);
      if (m && !m[2].includes(NUL)) {
        value = m[2];
        label = m[1];
        start = masked.indexOf(value, m.index);
      }
    }
    if (value === null) return;
    claimed[i].push([start, start + value.length]);
    // label is carried on the token (not shown in any finding, which still
    // only reports cls/value/line/expected/found -- see the design doc §3)
    // purely so compare()'s nearest-unclaimed-token fallback can restrict a
    // 'field' match to the SAME label. Every other STRICT class is
    // self-describing by shape (a date looks like a date); 'field' is the
    // one class where several genuinely different values share one class
    // name, so the fallback needs this extra identity to avoid pairing a
    // record's Proponent value against a photo's Classification value just
    // because they happen to be the nearest two unclaimed field tokens by
    // line -- found 2026-08-25 on a real photo with two real alterations at
    // once (see design doc §2a).
    out.push({ cls: 'field', value, line: i + 1, label });
  });
  return out;
}

// A signatory's printed name followed by an unstructured title/position
// block -- see docs/superpowers/specs/2026-09-09-signatory-title-comparison-design.md.
// Anchored on the LAST `name`-class token by line number (the signatory's
// own printed name in both real documents checked in the design doc's §2)
// -- an earlier ALL-CAPS run, like a SUBJECT line, must never be mistaken
// for the anchor. Bounded by the first blank line after the anchor, or end
// of text. Unlike every other extraction function in this file, this one
// consumes already-extracted tokens (nameTokens) rather than deriving
// everything from raw text alone -- it has to run after the TOKEN_PATTERNS
// loop that produces them.
function extractSignatoryTitleToken(rawLines, nameTokens) {
  if (nameTokens.length === 0) return null;
  const anchorLine = Math.max(...nameTokens.map((t) => t.line));
  const titleLines = [];
  for (let i = anchorLine; i < rawLines.length; i++) {
    const line = stripFooter(rawLines[i]).trim();
    if (line === '') break;
    titleLines.push(line);
  }
  if (titleLines.length === 0) return null;
  return { cls: 'signatoryTitle', value: titleLines.join(' '), line: anchorLine + 1 };
}

// The record's own set of field labels -- always clean, real PDF text.
// Collected once per compare() call and handed to the photo-side
// extraction (see extractTokens's opts.fieldLabels), so it can anchor on a
// known label instead of the punctuation after it.
function collectFieldLabels(text) {
  const labels = new Set();
  for (const raw of String(text ?? '').split('\n')) {
    const m = FIELD_LINE.exec(stripFooter(raw));
    if (m) labels.add(m[1]);
  }
  return labels;
}

// A hyphen-bulleted list entry, e.g. "- Darwin Karl Pua". See
// docs/superpowers/specs/2026-08-27-list-item-comparison-design.md.
//
// Unlike every other class, this runs FIRST (see extractTokens) and claims
// the entire line's span, not just the captured value. A list entry is
// compared as one atomic unit -- there's nothing for a later, more specific
// class to usefully claim inside it -- and leaving it late would let 'name'
// (which already claims ALL-CAPS runs like "DENR R1" inside real bulleted
// lines, confirmed 2026-08-27 against a real photo) partially carve up the
// line first, NUL-contaminating the value this would otherwise capture
// whole and silently dropping that entry from comparison.
//
// Only a plain hyphen bullet is recognized -- the one marker actually
// observed, consistently, across every real photo checked. See design doc
// §5.
//
// Not anchored to the line's true start. Real case, 2026-09-07: a photo
// taken from farther back (more background in frame) read stray marks --
// clutter, a fingertip's edge -- before EVERY bullet on the page, and the
// original ^\s* anchor made every single one invisible, along with the one
// alteration this feature exists to catch. The [A-Z0-9] requirement right
// after the hyphen+space is what keeps this from just grabbing the FIRST
// hyphen on the line when the noise itself contains one ("-. _- - Maria
// Delia..." -- the noise's own hyphen is followed by another hyphen, not a
// real word, so it fails this check and the search continues to the real
// bullet). Every real item on this document starts with a capital letter or
// a digit; a future document whose items don't would need this revisited.
const LIST_ITEM_LINE = /-\s+([A-Z0-9].*?)\s*$/;

// A numbered list entry, e.g. "9. Darwin Karl B. Pua". Unlike a hyphen
// bullet (see extractListItemTokens below), several items can share one
// physical OCR line: this document's list prints in two side-by-side
// columns ("Chester Lyndon S. Padilla 11. Mardave G. Nerveza" is items 1
// and 11 on one line), so this splits a line on EVERY marker found, not
// just the first. See
// docs/superpowers/specs/2026-09-09-numbered-item-comparison-design.md.
//
// A segment is only trusted -- extracted at all -- when unambiguously
// bounded: by another marker later on the same line, by the next physical
// line itself starting with a marker, or by being the text's last line.
// Real case, 2026-09-09: a completely different real document
// (test/fixtures/pages/, legal clauses) has its own numbered list, but
// each item wraps across two or three physical lines ("3. Effluent shall
// conform to... / inland water standards..."). Without this bounding
// rule, that document's clauses would be silently truncated to their
// first physical line and compared against a genuine photo's own
// (differently-positioned) truncation -- a live false-positive risk on an
// already-shipped feature, not a hypothetical. Checked directly against
// that document and all 3 of its real genuine photos: zero items
// extracted, either side, with this rule in place.
//
// The cost, found the same way: a segment that legitimately ends a
// document's own list, with ordinary prose (not another marker)
// immediately following and not literally the page's last line, is ALSO
// not trusted -- there is no local way to tell that apart from a wrapped
// continuation. Accepted, documented gap, not an oversight -- see the
// design doc's honest limits (§5).
//
// A next-line marker only counts as bounding when SOME marker on that
// line has a GREATER number than the current item's -- not merely "a
// marker is present there", and not restricted to the next line's first
// marker, and not required to be the exact successor either. Real
// regressions, all 2026-09-09 (test/fixtures/pages-special-order-383/,
// found one after another against real photos):
//
//   - Checking only "a marker is present" let item 18 -- the shorter
//     (right) column's LAST item, sitting on the same row as the longer
//     (left) column's item 8, with no same-line neighbor of its own --
//     be wrongly bounded by the next line's "9." (the left column
//     continuing), a marker, but for a SMALLER, unrelated number. That
//     produced a false "added" material finding on a genuine photo: item
//     18 was extracted (with trailing noise) with no record counterpart,
//     since the record's own #18 is never extracted at all (see this
//     comment's next paragraph).
//   - Requiring a greater number but checking only the next line's FIRST
//     marker then broke item 11 (the right column's first item): its
//     genuine successor, item 12, is on the next physical line too, but
//     as that line's SECOND marker (the left column's own item 2 comes
//     first) -- checking only the first marker missed it.
//   - Requiring the EXACT successor (not just "greater"), searched across
//     the whole next line, then broke a genuine item whose own successor
//     had gone missing from the photo one line below it: with item 10
//     absent, item 9's "next line" became item 11's line, which has no
//     marker equal to 9+1 -- cascading a second, unrelated item into a
//     false "missing" alongside the one that was actually gone. "Greater
//     than", not "exactly one more", is what a genuine continuation
//     actually requires; the exact-successor version was stricter than
//     the real data supports.
const NUMBERED_MARKER = /\b(\d{1,2})\.\s+/g;

function extractNumberedItemTokens(text, claimed) {
  const rawLines = String(text ?? '').split('\n');
  const stripped = rawLines.map((raw) => stripFooter(raw));
  const lineMarkers = stripped.map((line) => [...line.matchAll(NUMBERED_MARKER)]);
  const out = [];
  lineMarkers.forEach((markers, i) => {
    if (markers.length === 0) return;
    const nextLineMarkers = i + 1 < stripped.length ? lineMarkers[i + 1] : [];
    const isLastLine = i === stripped.length - 1;
    // No maskClaimed call: this runs before every other extractor (see
    // extractTokens), so claimed[i] is always empty here -- masking would
    // be a guaranteed no-op. If that ordering ever changes, this comment
    // is the tripwire to come back and add it.
    markers.forEach((m, idx) => {
      const hasNextOnLine = idx + 1 < markers.length;
      const end = hasNextOnLine ? markers[idx + 1].index : stripped[i].length;
      const nextLineContinues = nextLineMarkers.some((nm) => Number(nm[1]) > Number(m[1]));
      if (!hasNextOnLine && !nextLineContinues && !isLastLine) return;
      const start = m.index + m[0].length;
      const value = stripped[i].slice(start, end).trim();
      if (!value) return;
      claimed[i].push([m.index, end]);
      out.push({ cls: 'numberedItem', number: m[1], value, line: i + 1 });
    });
  });
  return out;
}

function extractListItemTokens(text, claimed) {
  const rawLines = String(text ?? '').split('\n');
  const stripped = rawLines.map((raw) => stripFooter(raw));
  // Matched per line first, unfiltered, so adjacency (below) can be decided
  // from the whole set before anything is claimed.
  const matches = stripped.map((line) => LIST_ITEM_LINE.exec(line));
  const out = [];
  matches.forEach((m, i) => {
    if (!m) return;
    // A genuine bulleted list is a multi-line structure. Real regression,
    // 2026-09-07: loosening LIST_ITEM_LINE to tolerate noise before a real
    // bullet (see its own comment) also let an ISOLATED line elsewhere on a
    // genuine photo of an unrelated, non-bulleted document match by sheer
    // chance ("1/3. xy - KI + B6IR-cer", garbled OCR of footer/seal noise),
    // fabricating an "added" list entry -- a false "altered" verdict on a
    // genuine page. Requiring at least one immediate neighbor to also match
    // is what a real list actually looks like and noise essentially never
    // does; the trade-off, accepted and not yet seen in practice, is a
    // genuine list of exactly one item would be invisible too.
    if (!matches[i - 1] && !matches[i + 1]) return;
    // No maskClaimed call: this runs before every other extractor (see
    // extractTokens), so claimed[i] is always empty here -- masking would
    // be a guaranteed no-op. If that ordering ever changes, this comment is
    // the tripwire to come back and add it.
    claimed[i].push([0, stripped[i].length]);
    out.push({ cls: 'listItem', value: m[1], line: i + 1 });
  });
  return out;
}

// Order matters: the first pattern to claim a span wins, so the more specific
// classes are listed before the looser ones. `name` is last because a run of
// capitals would otherwise swallow "Section 12" style citations. Money is not
// in this list at all -- extractTokens runs extractListItemTokens, then
// extractMoneyTokens, ahead of this loop, so between the two of them a
// bulleted list line or an amount still claims first exactly as money did
// when it was the first entry here.
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
  ['reference', new RegExp(String.raw`\bR[${REFERENCE_DIGITISH}]${REFERENCE_SEP}[${REFERENCE_DIGITISH}]{4}${REFERENCE_SEP}[${REFERENCE_DIGITISH}]{6}\b|\bNo\.\s?[${REFERENCE_DIGITISH}]{2}${REFERENCE_SEP}[${REFERENCE_DIGITISH}]{3,6}\b`, 'g')],
  ['citation', new RegExp(String.raw`\b(?:Section|Sec\.|Rule|Article|Art\.)\s+(?:${CITATION_NUMERAL})(?![A-Za-z0-9])`, 'gi')],
  // Real line boundaries (src/pdfTools.js's extractPageTextsWithLines,
  // wired in via src/verifyPageImage.js) are what stop a name run now, not
  // a word count. A fixed 6-word cap used to stand in for that boundary and
  // is removed: keeping it alongside real line info would be actively
  // wrong, not just redundant -- it would wrongly truncate any genuine
  // single printed line naming something longer than 6 words. See
  // docs/superpowers/specs/2026-08-25-record-line-preserving-extraction-design.md.
  ['name', new RegExp(String.raw`\b[A-Z][A-Z&.'-]+(?:\s+[A-Z][A-Z&.'-]+)+\b`, 'g')],
];

// Tokens the record carries that must survive in the photo, each tied to the
// line it sits on so a finding can point somewhere on the sheet. Also the
// entry point the photo side uses (see compare(), below) -- money, and every
// other class, is extracted identically for both.
export function extractTokens(text, opts = {}) {
  // stripFooter canonicalizes whitespace, which would destroy line structure —
  // so split first and strip the footer per line, keeping line numbers intact.
  const rawLines = String(text ?? '').split('\n');
  const out = [];
  const claimed = rawLines.map(() => []);

  // Runs before every other class -- see extractListItemTokens's own
  // comment for why a bulleted line must claim its whole span first.
  out.push(...extractListItemTokens(text, claimed));

  // Same reasoning, same position -- see extractNumberedItemTokens's own
  // comment for the bounding rule this needs that extractListItemTokens
  // does not.
  out.push(...extractNumberedItemTokens(text, claimed));

  // Money next, same position it held inside TOKEN_PATTERNS before it moved
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
        // reference's shape is rigid enough (R + dash-delimited 1/4/6-length
        // groups) that an all-lookalike-letters match is effectively
        // impossible in real prose, but the same guard money already applies
        // to its own DIGITISH run is free insurance against a phantom token
        // built from zero real digits.
        if (cls === 'reference' && !hasRealDigit(m[0])) continue;
        claimed[i].push([m.index, m.index + m[0].length]);
        out.push({ cls, value: m[0], line: i + 1 });
      }
    });
  }

  // Last of all -- a labeled field's value is whatever's left on its line
  // once every more specific class has already claimed its own span.
  out.push(...extractFieldTokens(text, claimed, opts.fieldLabels));

  // Last of all -- needs the `name` tokens already produced above as its anchor.
  const signatoryTitle = extractSignatoryTitleToken(rawLines, out.filter((t) => t.cls === 'name'));
  if (signatoryTitle) out.push(signatoryTitle);

  return out.sort((a, b) => a.line - b.line);
}

// Calibrated 2026-08-24 against real phone photographs of real printed pages
// (test/fixtures/pages/, scripts/ocr-calibrate.mjs) — not renders, per spec
// §9.2. From 2 genuine pages and 1 page of a different document: genuine
// similarity floor 0.739, other-page ceiling 0.000. samePageMin sits with wide
// margin on both sides of that gap. Revisit once the fixture set reaches the
// plan's full 5 genuine / 1 other minimum — this round only had one of each
// non-genuine label, so the floor/ceiling could still shift.
export const THRESHOLDS = {
  samePageMin: 0.4, // below this, the photo is not this page at all
  minWords: 20, // below this, OCR did not read enough to say anything — not
  // recalibrated this round; no criterion in Task 8 measured it directly
};

const STRICT = new Set(['money', 'date', 'duration', 'reference', 'citation', 'field']);

// Citations no longer need a special-cased Roman-numeral fold: GLYPH_FOLD
// already maps I, l and | to '1', so folding before lowercasing (below)
// makes foldGlyphs('Rule III') and foldGlyphs('Rule Ill') identical on the
// ordinary key path. A dedicated ROMAN_FOLD used to be applied here, but it
// ran on an already-uppercased string against a pattern that only matched
// lowercase l/v, so it was a no-op — removed rather than fixed in place.
// A separator followed by exactly three digits is a thousands separator; a
// period followed by two is centavos. That is how the amounts on these pages
// are actually printed, and it is decidable from the string alone -- so
// "50,000.00", "50000.00" and "50.000.00" all key as "50000.00" (spec §5.4:
// unify separators, both sides) while "50,000.00" and "500,000.00" still
// differ, in length, whether or not either carries a comma. The centavos
// point is deliberately NOT stripped: strip it too and "₱50,000.00" would key
// identically to "₱5,000,000", hiding a hundredfold edit.
const THOUSANDS_SEP = /[,.](?=\d{3}(?:\D|$))/g;

function keyFor(cls, value) {
  const collapsed = String(value).replace(/\s+/g, ' ').trim();
  // Fold before lowercasing, not after: GLYPH_FOLD's B, D, Q, S, Z, G entries
  // are uppercase-only (no lowercase counterpart -- neither is 'I', despite
  // 'i' looking like it should count), so folding a pre-lowercased string
  // leaves several of the map's letter rules dead. This never mattered for
  // 'name' specifically -- its extraction pattern is letters-only, so a
  // digit-substituted word (the only thing this fold ever forgives) can
  // never form a valid name token to begin with, on either side, at any
  // fold order. It matters here because 'field' (below) extracts its value
  // with no such restriction -- real calibration data found a genuine
  // "Category B" photographed as "Category 8", which only this order
  // forgives.
  const foldedCase = foldGlyphs(collapsed).toLowerCase();
  if (cls === 'name' || cls === 'field' || cls === 'listItem' || cls === 'numberedItem' || cls === 'signatoryTitle') return foldLetterNoise(foldedCase);
  const key = foldedCase.replace(/^(?:php|p)\s?/, '₱');
  // Reference only: fold the same hyphen-lookalikes REFERENCE_SEP already
  // tolerates at extraction to a canonical '-', so a misread separator
  // ("Rl~2026-001024") keys identically to the clean record value instead
  // of comparing as a different reference entirely.
  if (cls === 'reference') return key.replace(new RegExp(REFERENCE_SEP, 'g'), '-');
  // Money only. reasonFor's digit-count comparison is unaffected: digitsOf
  // drops every non-digit anyway, so materiality is decided on real digits
  // (50,000 -> 5 vs 500,000 -> 6) regardless of what the key does.
  if (cls !== 'money') return key;
  // Strip thousands separators first, THEN normalize whatever separator
  // survives immediately before a final two-digit group to '.' -- a comma
  // there can now only be CENTAVOS (THOUSANDS_SEP already consumed every
  // comma/period that was followed by three digits), so "₱50,000,00" and
  // "₱500,00" key identically to "₱50,000.00" and "₱500.00". Order matters:
  // running this before the THOUSANDS_SEP strip would misfire on a genuine
  // three-digit group that happens to end the string (there is none here,
  // since THOUSANDS_SEP already claimed those), so it must run second.
  return key.replace(THOUSANDS_SEP, '').replace(/,(?=\d{2}$)/, '.');
}

// Multi-letter OCR confusions that dominate long words -- shared by tolerant
// name comparison and strict field-value comparison (see keyFor above).
// Kept separate from foldGlyphs, a single-character map reused by
// money/reference/citation too that must run before lowercasing; these
// letter-RUN folds only make sense on an already-lowercased string, which
// keyFor guarantees before calling this.
function foldLetterNoise(s) {
  return s.replace(/rn/g, 'm').replace(/cl/g, 'd').replace(/vv/g, 'w');
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

// True when one key is the other continued word-for-word, from the start --
// never a partial-word coincidence, since both sides are split on the single
// space keyFor already collapses whitespace to. This is the record's total
// lack of line-break info meeting a real printed wrap: the record's flattened
// text has no boundary where a title genuinely wraps to a second physical
// line, and if the trailing word lands alone on that line, it fails the name
// pattern's 2-word minimum and never becomes a token the photo side can even
// offer -- so the photo's token is a clean truncation of the record's, not a
// misread of it.
function isWrapPrefix(a, b) {
  const wa = a.split(' ');
  const wb = b.split(' ');
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return shorter.length > 0 && shorter.every((w, i) => longer[i] === w);
}

// numberedItem is identified by its NUMBER, not a fold of its value --
// every other class's identity IS its folded value, which is what
// compare()'s generic record<->photo passes key on. Forcing numberedItem
// through that mechanism would mean "same key" stops meaning "same
// content" for this one class, so it gets its own dedicated pass instead;
// compare() excludes numberedItem tokens from both generic passes (search
// for "cls === 'numberedItem'" there). See
// docs/superpowers/specs/2026-09-09-numbered-item-comparison-design.md §4.
function compareNumberedItems(authTokens, ocrTokens) {
  const authByNum = new Map();
  for (const t of authTokens) if (t.cls === 'numberedItem') authByNum.set(t.number, t);
  const ocrByNum = new Map();
  for (const t of ocrTokens) if (t.cls === 'numberedItem') ocrByNum.set(t.number, t);

  const findings = [];
  let suppressed = 0;

  for (const [num, authTok] of authByNum) {
    const ocrTok = ocrByNum.get(num);
    if (!ocrTok) {
      suppressed++;
      findings.push({
        severity: 'tolerant', cls: 'numberedItem', line: authTok.line,
        expected: authTok.value, found: null, reason: 'missing',
      });
      continue;
    }
    const a = keyFor('numberedItem', authTok.value);
    const o = keyFor('numberedItem', ocrTok.value);
    if (a === o || isWrapPrefix(a, o)) continue;
    findings.push({
      severity: 'material', cls: 'numberedItem', line: authTok.line,
      expected: authTok.value, found: ocrTok.value, reason: 'text',
    });
  }

  for (const [num, ocrTok] of ocrByNum) {
    if (authByNum.has(num)) continue;
    findings.push({
      severity: 'material', cls: 'numberedItem', line: null,
      expected: null, found: ocrTok.value, reason: 'added',
    });
  }

  return { findings, suppressed };
}

// PROVISIONAL -- not yet measured against real photos, see design doc §5.
// The real case this exists for (a 4-line title collapsed to 2 words)
// measures at ~0.22; this sits with wide margin above it and below where
// ordinary OCR noise on a genuine title is expected to land. Task 3 of
// docs/superpowers/plans/2026-09-09-signatory-title-comparison.md replaces
// this with a real measured value.
const SIGNATORY_TITLE_SIMILARITY_FLOOR = 0.7;

// signatoryTitle is identified by being the document's one signature-block
// title, not a repeatable key -- same reasoning as compareNumberedItems,
// see docs/superpowers/specs/2026-09-09-signatory-title-comparison-design.md
// §4. A dedicated pass because there is no positional/numeric identity to
// pair on, and because the whole point is comparing free prose tolerantly
// -- exactly what the generic key-based passes are not built for.
function compareSignatoryTitle(authTokens, ocrTokens) {
  const authTok = authTokens.find((t) => t.cls === 'signatoryTitle');
  const ocrTok = ocrTokens.find((t) => t.cls === 'signatoryTitle');
  if (!authTok) return { findings: [], suppressed: 0 };
  if (!ocrTok) {
    return {
      findings: [{
        severity: 'tolerant', cls: 'signatoryTitle', line: authTok.line,
        expected: authTok.value, found: null, reason: 'missing',
      }],
      suppressed: 1,
    };
  }
  const a = keyFor('signatoryTitle', authTok.value).split(' ');
  const o = keyFor('signatoryTitle', ocrTok.value).split(' ');
  if (similarity(a, o) >= SIGNATORY_TITLE_SIMILARITY_FLOOR) return { findings: [], suppressed: 0 };
  return {
    findings: [{
      severity: 'material', cls: 'signatoryTitle', line: authTok.line,
      expected: authTok.value, found: ocrTok.value, reason: 'text',
    }],
    suppressed: 0,
  };
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
  // The record's own field labels are always clean (real PDF text) -- handed
  // to the photo side so it can anchor a labeled field on the label itself,
  // not on whatever the colon after it degraded into. See
  // docs/superpowers/specs/2026-08-25-labeled-field-comparison-design.md §3.
  const ocrTokens = extractTokens(ocrText, { fieldLabels: collectFieldLabels(authText) });
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
    if (t.cls === 'numberedItem') continue; // handled by compareNumberedItems below
    if (t.cls === 'signatoryTitle') continue; // handled by compareSignatoryTitle below (Task 2)
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
      // 'field' is the one class where several genuinely different values
      // share one class name (every other STRICT class is self-describing
      // by shape) -- without this, two real alterations on the same photo
      // could pair a record's Proponent value against a photo's
      // Classification value just because they're the nearest two
      // unclaimed field tokens by line. See extractFieldTokens's comment
      // on why label is carried on the token.
      if (t.cls === 'field' && o.label !== t.label) continue;
      const dist = Math.abs(o.line - t.line);
      if (dist < bestDist) {
        bestDist = dist;
        near = o;
      }
    }
    if (near) consumedNear.add(near);
    if (!strict) {
      if (near && isWrapPrefix(keyFor(t.cls, t.value), keyFor(near.cls, near.value))) continue;
      suppressed++;
      findings.push({
        severity: 'tolerant', cls: t.cls, line: t.line,
        expected: t.value, found: near ? near.value : null, reason: 'text',
      });
      continue;
    }
    // A control/reference number's true absence -- nothing reference-shaped
    // read ANYWHERE in the photo -- is not the same claim as "this number
    // is wrong." Real complaint, 2026-08-27: a photo framed to focus on the
    // document's content legitimately crops the footer stamp out of frame
    // entirely; reporting that as an alteration flags an ordinary photo,
    // not a tampered one. A reference that IS read, even garbled, is still
    // fully compared above via the ordinary `near` path and reasonFor --
    // only true absence (near === null) is softened, and only for this one
    // class. Every other STRICT class, and an unexpected reference VALUE
    // appearing in the photo-to-record pass below, is unchanged.
    if (t.cls === 'reference' && !near) {
      suppressed++;
      findings.push({
        severity: 'tolerant', cls: t.cls, line: t.line,
        expected: t.value, found: null, reason: 'missing',
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
    if (o.cls === 'numberedItem') continue; // handled by compareNumberedItems below
    if (!STRICT.has(o.cls) && o.cls !== 'listItem') continue;
    if (consumedNear.has(o)) continue; // already paired above
    if (o.cls === 'citation' && !citationHasRealEvidence(o.value)) continue;
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

  const numbered = compareNumberedItems(authTokens, ocrTokens);
  findings.push(...numbered.findings);
  suppressed += numbered.suppressed;

  const signatoryTitle = compareSignatoryTitle(authTokens, ocrTokens);
  findings.push(...signatoryTitle.findings);
  suppressed += signatoryTitle.suppressed;

  // Word-level differences not accounted for by any token finding are the
  // ordinary noise of reading paper. Counted, shown, not itemised as findings.
  const wordDiff = Math.max(authWords.length, ocrWords.length) - lcsLength(ocrWords, authWords);
  suppressed += Math.max(0, wordDiff - findings.length);

  const order = { material: 0, tolerant: 1 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || (a.line ?? 1e9) - (b.line ?? 1e9));

  return { status: 'compared', similarity: sim, findings, suppressed };
}
