/**
 * Look up a document in the local index by canonical key (IIS No.).
 * @returns {object|null} the documents row, or null if absent.
 */
export function localLookup(db, key) {
  if (!key) return null;
  return db.prepare('SELECT * FROM documents WHERE iis_no = ?').get(key) ?? null;
}
