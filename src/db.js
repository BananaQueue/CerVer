import { DatabaseSync } from 'node:sqlite';

/**
 * Open (or create) the CerVer SQLite database and ensure the schema exists.
 * Idempotent — safe to call on every start.
 * @param {string} dbPath  file path or ':memory:'
 * @returns {DatabaseSync}
 */
export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      iis_no           TEXT PRIMARY KEY,
      subject_name     TEXT,
      company_name     TEXT,
      address          TEXT,
      emb_id           TEXT,
      transaction_type TEXT,
      attachment_ref   TEXT,
      source           TEXT NOT NULL DEFAULT 'excel',
      first_seen       TEXT,
      last_verified    TEXT
    );
    CREATE TABLE IF NOT EXISTS verify_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              TEXT NOT NULL,
      queried_id      TEXT,
      resolved_iis_no TEXT,
      outcome         TEXT NOT NULL,
      path            TEXT NOT NULL,
      client_hint     TEXT
    );
    CREATE TABLE IF NOT EXISTS pages (
      iis_no          TEXT NOT NULL,
      page_no         INTEGER NOT NULL,
      total_pages     INTEGER NOT NULL,
      digest          TEXT NOT NULL,
      seal            TEXT NOT NULL,
      kid             TEXT NOT NULL,
      sealed_pdf_path TEXT,
      created_at      TEXT NOT NULL,
      PRIMARY KEY (iis_no, page_no)
    );
  `);
  return db;
}
