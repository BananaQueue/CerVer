// Locates each finding's `found` value among the OCR engine's recognized
// words, and attaches a `region` (bounding box + confidence) when found.
//
// Runs strictly AFTER pageCompare.compare() has already decided the findings.
// This module can only ADD a region to an existing finding -- it can never
// create, remove, or change the severity/reason/expected/found of one. A box
// is a location pointer, not a verdict; only its styling depends on
// confidence, and this module doesn't even decide styling, just supplies the
// number the frontend styles with.
//
// See docs/superpowers/specs/2026-08-17-ocr-confidence-boxes-design.md

function normalizeWord(s) {
  return String(s ?? '').toLowerCase().trim();
}

function normalizeTarget(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function unionBbox(a, b) {
  if (!b) return { x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 };
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

// Finds the first not-yet-consumed contiguous run of `words` whose
// concatenated, normalized text equals `target`'s normalized text. Consumes
// the run's indices on success, so a second finding can never claim the same
// words -- this is what makes two identical `found` values resolve to two
// different regions instead of the same one twice.
//
// Returns null on no match. This is the ordinary, expected outcome when OCR
// fragmented a value across a line break or split it unexpectedly -- not an
// error. The caller (locateFindings) treats null exactly like "no region".
function findRun(target, words, consumed) {
  const wantWords = normalizeTarget(target).split(' ').filter(Boolean);
  if (wantWords.length === 0) return null;

  for (let start = 0; start < words.length; start++) {
    if (consumed.has(start)) continue;

    let bbox = null;
    let minConfidence = Infinity;
    const used = [];
    let wi = 0;
    let idx = start;

    while (wi < wantWords.length && idx < words.length && !consumed.has(idx)) {
      const word = words[idx];
      if (normalizeWord(word.text) !== wantWords[wi]) break;
      bbox = unionBbox(word.bbox, bbox);
      minConfidence = Math.min(minConfidence, word.confidence);
      used.push(idx);
      wi++;
      idx++;
    }

    if (wi === wantWords.length) {
      for (const i of used) consumed.add(i);
      return { ...bbox, confidence: minConfidence };
    }
  }
  return null;
}

export function locateFindings(findings, words) {
  const safeWords = Array.isArray(words) ? words : [];
  const consumed = new Set();
  return findings.map((f) => {
    if (f.found === null || f.found === undefined) return { ...f };
    const region = findRun(f.found, safeWords, consumed);
    return region ? { ...f, region } : { ...f };
  });
}
