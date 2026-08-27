// Drops a tolerant (never material) finding when the underlying photo text
// was read with too little confidence to be worth itemizing as an explained
// "difference." Runs strictly AFTER ocrRegions.js's locateFindings(), which
// is what attaches region.confidence in the first place -- this module
// never re-derives it.
//
// See docs/superpowers/specs/2026-08-25-tolerant-finding-confidence-filter-design.md
//
// Contract, as narrow and explicit as locateFindings()'s own:
//   - may remove a finding with severity 'tolerant' when region.confidence
//     is below minConfidence
//   - never touches a finding with severity 'material', at any confidence
//   - never touches a finding with no region at all (nothing to measure)
//   - never modifies a finding it keeps
export function dropLowConfidenceTolerant(findings, minConfidence) {
  return findings.filter((f) => {
    if (f.severity !== 'tolerant') return true;
    if (!f.region) return true;
    return f.region.confidence >= minConfidence;
  });
}
