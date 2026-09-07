import fs from 'node:fs/promises';
import { extractPageTextsWithLines } from './pdfTools.js';
import { compare, THRESHOLDS } from './pageCompare.js';
import { recognize as defaultRecognize } from './ocr.js';
import { locateFindings } from './ocrRegions.js';
import { stripOcrFooter } from './ocrFooter.js';
import { dropLowConfidenceTolerant } from './ocrNoiseFilter.js';

// Compare a photograph of a printed page against the page as it was sealed.
//
// EVIDENCE, NOT PROOF (spec §2). The seal is what verifies a page; this only
// says which values on the sheet disagree with the record, and it never changes
// a seal verdict. A photograph that cannot be read costs the document nothing.

// Below this, the reading is too poor to say anything about the page. Reported
// as a request for a better photo — never as a finding.
//
// MEASURED (2026-08-24, real poor/genuine gap; re-measured 2026-08-27 after
// ocr.js's meanConfidence switched from Tesseract's raw page-average to
// content-word-only confidence — see
// docs/superpowers/specs/2026-08-27-content-word-confidence-design.md).
// Most `poor`-labelled attempts (angle, reduced framing) still read at
// 0.763-0.834 — ABOVE the lowest genuine reading — because the iPhone's Deep
// Fusion pipeline (on by default, no user setting to disable it) corrects
// deliberately bad captures back to something legible. That limitation is
// accepted, not fixed here: confidence alone cannot catch every poor photo,
// only genuinely degraded ones. Two captures did get past Deep Fusion (real
// motion blur / dim handheld shake): 0.514 and 0.576, both clearly below the
// lowest genuine reading measured across 11 genuine samples (0.750). This
// sits with margin on both sides of that real gap (+0.074 above the
// real-poor ceiling, -0.10 below the genuine floor), not a guess.
const MIN_CONFIDENCE = 0.65;

// MEASURED (2026-08-25, real genuine-page data via scripts/ocr-calibrate.mjs's
// criterion 5). Genuine pages' tolerant (name-class) findings clustered at
// two extremes: near-zero confidence (0.000 -- a fully garbled word) or
// 0.820-0.960 (a legitimately read, merely non-material difference). No
// real genuine-page data point fell between them. This sits in that gap,
// with margin on both sides -- the same measured-not-guessed practice as
// MIN_CONFIDENCE and THRESHOLDS.samePageMin.
const MIN_TOLERANT_CONFIDENCE = 0.4;

export async function verifyPageImage(
  db,
  imageBytes,
  { iisNo, k, clientHint = null, ocr = defaultRecognize } = {}
) {
  const log = (status) => {
    db?.prepare(
      'INSERT INTO verify_log (ts, queried_id, resolved_iis_no, outcome, path, client_hint) VALUES (?,?,?,?,?,?)'
    ).run(new Date().toISOString(), `${iisNo}/p${k}`, iisNo, `page_image_${status}`, 'public', clientHint);
  };
  const done = (report) => {
    log(report.status);
    return { ...report, iisNo, k };
  };
  const bare = (status) => done({ status, similarity: 0, findings: [], suppressed: 0 });

  const row = db?.prepare('SELECT sealed_pdf_path FROM pages WHERE iis_no=? AND page_no=?').get(iisNo, k);
  if (!row?.sealed_pdf_path) return bare('no_record_copy');

  let authText;
  try {
    const bytes = await fs.readFile(row.sealed_pdf_path);
    authText = (await extractPageTextsWithLines(bytes))[k - 1];
  } catch {
    // The row points at a file that is gone or unreadable. That is a gap in the
    // record, not evidence about the sheet in someone's hand.
    return bare('no_record_copy');
  }
  if (!authText) return bare('no_record_copy');

  // A failure HERE is the engine breaking (worker never started, or crashed
  // mid-recognition) -- a defect in the service, not evidence about the photo.
  // It must never fold into image_unreadable (spec §7: that status means OCR
  // read the image and found too little, not that the engine is broken). So
  // the error is not caught and turned into a report; it is re-thrown with a
  // message that unambiguously names it as an engine failure -- preserving
  // whatever the engine itself said -- and left to propagate. The route
  // handler (src/app.js) is what actually catches it and answers the client;
  // there is no handler for it here on purpose.
  let read;
  try {
    read = await ocr(imageBytes);
  } catch (err) {
    const engineMsg = err?.message ?? String(err);
    throw new Error(`OCR engine failure: ${engineMsg}`);
  }
  if (read.meanConfidence < MIN_CONFIDENCE || read.wordCount < THRESHOLDS.minWords) {
    return bare('image_unreadable');
  }

  const cleanedText = stripOcrFooter(read.text, read.words);
  const report = compare(cleanedText, authText);
  const located = locateFindings(report.findings, read.words);
  const findings = dropLowConfidenceTolerant(located, MIN_TOLERANT_CONFIDENCE);
  // The photo's overall read confidence, for the report to show alongside a
  // finding -- so a reviewer can weigh "this one word read badly" against
  // "the whole photo read badly" or "the whole photo read fine". Computed
  // above for the image_unreadable gate; simply never returned until now.
  return done({ ...report, findings, meanConfidence: read.meanConfidence });
}
