import { normalize } from './normalizer.js';
import { localLookup } from './localLookup.js';

/**
 * Orchestrates verification: normalize -> local lookup -> (staff-gated) live IIS
 * lookup -> cache. Always records an audit row in verify_log.
 *
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {(norm:object)=>Promise<object|null>} deps.iisLookup
 * @returns {(idOrToken:string, opts?:{path?:'public'|'staff', clientHint?:string|null})=>Promise<{status:string,id:string,record:object|null}>}
 */
export function createVerifier({ db, iisLookup }) {
  const logStmt = db.prepare(
    'INSERT INTO verify_log (ts, queried_id, resolved_iis_no, outcome, path, client_hint) VALUES (?,?,?,?,?,?)'
  );
  const cacheStmt = db.prepare(`
    INSERT INTO documents
      (iis_no, subject_name, company_name, address, emb_id, transaction_type, attachment_ref, source, first_seen, last_verified)
    VALUES (?,?,?,?,?,?,?, 'iis_live', ?, ?)
    ON CONFLICT(iis_no) DO UPDATE SET
      subject_name=excluded.subject_name,
      company_name=excluded.company_name,
      address=excluded.address,
      emb_id=excluded.emb_id,
      transaction_type=excluded.transaction_type,
      attachment_ref=excluded.attachment_ref,
      source='iis_live',
      last_verified=excluded.last_verified
  `);
  const getStmt = db.prepare('SELECT * FROM documents WHERE iis_no=?');

  return async function verify(idOrToken, { path = 'public', clientHint = null } = {}) {
    const now = new Date().toISOString();
    const norm = normalize(idOrToken);

    if (norm.kind === 'unknown') {
      logStmt.run(now, norm.raw, null, 'not_found', path, clientHint);
      return { status: 'invalid', id: norm.canonicalId, record: null };
    }

    const hit = localLookup(db, norm.lookupKey);
    if (hit) {
      logStmt.run(now, norm.raw, hit.iis_no, 'local_hit', path, clientHint);
      return { status: 'verified_local', id: norm.canonicalId, record: hit };
    }

    if (path === 'staff') {
      const live = await iisLookup(norm);
      if (live) {
        cacheStmt.run(
          live.iis_no,
          live.subject_name ?? '',
          live.company_name ?? '',
          live.address ?? '',
          live.emb_id ?? '',
          live.transaction_type ?? '',
          live.attachment_ref ?? '',
          now,
          now
        );
        const record = getStmt.get(live.iis_no);
        logStmt.run(now, norm.raw, live.iis_no, 'iis_hit', path, clientHint);
        return { status: 'verified_live', id: norm.canonicalId, record };
      }
      logStmt.run(now, norm.raw, null, 'not_found', path, clientHint);
      return { status: 'not_found', id: norm.canonicalId, record: null };
    }

    logStmt.run(now, norm.raw, null, 'not_found', path, clientHint);
    return { status: 'needs_staff', id: norm.canonicalId, record: null };
  };
}
