import fs from 'node:fs/promises';
import { extractPageTexts } from './pdfTools.js';
import { compare, THRESHOLDS } from './pageCompare.js';
import { recognize as defaultRecognize } from './ocr.js';

// Compare a photograph of a printed page against the page as it was sealed.
//
// EVIDENCE, NOT PROOF (spec §2). The seal is what verifies a page; this only
// says which values on the sheet disagree with the record, and it never changes
// a seal verdict. A photograph that cannot be read costs the document nothing.

// Below this, the reading is too poor to say anything about the page. Reported
// as a request for a better photo — never as a finding.
const MIN_CONFIDENCE = 0.5;

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

  const read = await ocr(imageBytes);
  if (read.meanConfidence < MIN_CONFIDENCE || read.wordCount < THRESHOLDS.minWords) {
    return bare('image_unreadable');
  }

  return done(compare(read.text, authText));
}
