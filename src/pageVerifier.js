import { parseFooter, computeSeal, sealsEqual } from './sealCode.js';

/**
 * Verify a single page from its footer code alone (typed or scanned).
 *
 * A lone code can only prove the code is AUTHENTIC for page k of n of a document
 * — it cannot detect body edits (the genuine seal is still printed on an altered
 * page). Body-edit detection is the staff step: on `page_verified`, staff open
 * the authoritative page (sealed_pdf_path) and compare. Full auto-detection is
 * the job of docVerifier (whole-PDF upload).
 */
export function createPageVerifier({ db, keyProvider }) {
  const logStmt = db
    ? db.prepare(
        'INSERT INTO verify_log (ts, queried_id, resolved_iis_no, outcome, path, client_hint) VALUES (?,?,?,?,?,?)'
      )
    : null;
  const rowStmt = db ? db.prepare('SELECT * FROM pages WHERE iis_no=? AND page_no=?') : null;

  return function verifyPage(input, { path = 'public', clientHint = null } = {}) {
    const parsed = typeof input === 'string' ? parseFooter(input) : input;
    const log = (status, iisNo) => {
      if (logStmt) {
        logStmt.run(
          new Date().toISOString(),
          parsed ? `${parsed.iisNo}/p${parsed.k}` : String(input),
          iisNo ?? null,
          status,
          path,
          clientHint
        );
      }
    };

    if (!parsed || !parsed.seal) {
      log('invalid_code', null);
      return { status: 'invalid_code' };
    }

    const { iisNo, k, n } = parsed;
    const row = rowStmt ? rowStmt.get(iisNo, k) : null;
    if (!row) {
      log('not_sealed', iisNo);
      return { status: 'not_sealed', iisNo, k, n };
    }
    if (row.total_pages !== n) {
      log('page_count_mismatch', iisNo);
      return { status: 'page_count_mismatch', iisNo, k, n, expectedPages: row.total_pages };
    }

    const secret = keyProvider.secretFor(row.kid);
    const expected = computeSeal(secret, { iisNo, k, n: row.total_pages, digest: row.digest });
    const authentic = sealsEqual(expected, parsed.seal) && sealsEqual(row.seal, parsed.seal);
    if (!authentic) {
      log('invalid_seal', iisNo);
      return { status: 'invalid_seal', iisNo, k, n };
    }

    log('page_verified', iisNo);
    const result = { status: 'page_verified', iisNo, k, n };
    if (path === 'staff') {
      result.authoritative = { sealedPdfPath: row.sealed_pdf_path, pageNo: k };
    }
    return result;
  };
}
