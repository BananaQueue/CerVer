import fs from 'node:fs/promises';
import { extractPageTexts } from './pdfTools.js';
import { compare, THRESHOLDS } from './pageCompare.js';
import { recognize as defaultRecognize } from './ocr.js';
import { locateFindings } from './ocrRegions.js';
import { stripOcrFooter } from './ocrFooter.js';

// Compare a photograph of a printed page against the page as it was sealed.
//
// EVIDENCE, NOT PROOF (spec §2). The seal is what verifies a page; this only
// says which values on the sheet disagree with the record, and it never changes
// a seal verdict. A photograph that cannot be read costs the document nothing.

// Below this, the reading is too poor to say anything about the page. Reported
// as a request for a better photo — never as a finding.
//
// MEASURED (2026-08-24, real poor/genuine gap). Most `poor`-labelled attempts
// (angle, reduced framing) still read at 0.740-0.760 — ABOVE the lowest
// genuine reading — because the iPhone's Deep Fusion pipeline (on by default,
// no user setting to disable it) corrects deliberately bad captures back to
// something legible. That limitation is accepted, not fixed here: confidence
// alone cannot catch every poor photo, only genuinely degraded ones. Two
// captures did get past Deep Fusion (real motion blur / dim handheld shake):
// 0.470 and 0.550, both clearly below the lowest genuine reading measured
// across 10 genuine samples (0.720). This sits with margin on both sides of
// that real gap, not a guess above the genuine floor.
const MIN_CONFIDENCE = 0.65;

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
    authText = (await extractPageTexts(bytes))[k - 1];
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
  const findings = locateFindings(report.findings, read.words);
  return done({ ...report, findings });
}
