// Finding a document's control number in its own text.
//
// Staff used to type this in. Reading it off the document instead removes a
// transcription step from the one field that binds every page seal to a
// document — a typo here does not fail loudly, it seals the pages under the
// wrong number.
//
// Only R1-YYYY-NNNNNN is looked for. That is the only shape `payload.js` can
// carry, so a document without one cannot be sealed whatever is typed; there is
// nothing to gain by recognising numbering this system cannot encode.
//
// Every distinct match is returned rather than just a winner. Body text can cite
// other documents' numbers, and a verification system should show that
// ambiguity to the person confirming rather than resolve it quietly.

// Not preceded or followed by more of the same token, so a number embedded in a
// longer run of digits or letters is not mistaken for a whole one.
const NUMBER = /(?<![A-Za-z0-9])R1-(?:20|21)\d\d-\d{6}(?![A-Za-z0-9])/g;

// "Control No. 1234", "CONTROL NO: 1234", "Control Number 1234".
const LABEL = /control\s*(?:no\.?|number)\s*:?\s*$/i;

// How far back to look for the label. Long enough for the longest spelling with
// generous spacing, short enough that a label belonging to an earlier number on
// the same line cannot reach the next one.
const LOOKBACK = 24;

/**
 * @param {(string|null|undefined)[]} pageTexts one entry per page, in order
 * @returns {{best: string|null, candidates: {iisNo: string, pages: number[], labelled: boolean}[]}}
 *   candidates ranked best first: labelled before bare, then by pages seen on,
 *   then by where it first appeared.
 */
export function detectControlNo(pageTexts) {
  const found = new Map(); // iisNo -> { iisNo, pages:Set, labelled, firstSeen }
  let order = 0;

  (Array.isArray(pageTexts) ? pageTexts : []).forEach((text, i) => {
    if (typeof text !== 'string' || !text) return; // a page that failed to extract
    for (const m of text.matchAll(NUMBER)) {
      const iisNo = m[0];
      const labelled = LABEL.test(text.slice(Math.max(0, m.index - LOOKBACK), m.index));
      let e = found.get(iisNo);
      if (!e) found.set(iisNo, (e = { iisNo, pages: new Set(), labelled: false, firstSeen: order++ }));
      e.pages.add(i + 1);
      // Labelled anywhere is enough: one clear statement outweighs loose mentions.
      if (labelled) e.labelled = true;
    }
  });

  const candidates = [...found.values()]
    .sort(
      (a, b) =>
        Number(b.labelled) - Number(a.labelled) ||
        b.pages.size - a.pages.size ||
        a.firstSeen - b.firstSeen
    )
    .map(({ iisNo, pages, labelled }) => ({ iisNo, pages: [...pages].sort((x, y) => x - y), labelled }));

  return { best: candidates.length ? candidates[0].iisNo : null, candidates };
}
