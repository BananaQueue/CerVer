import ExcelJS from 'exceljs';

const COLS = [
  'iis_no',
  'subject_name',
  'company_name',
  'address',
  'emb_id',
  'transaction_type',
  'attachment_ref',
];

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') return v.text ?? v.hyperlink ?? '';
  return String(v);
}
function cellRef(v) {
  if (v && typeof v === 'object') return v.hyperlink ?? v.text ?? '';
  return v == null ? '' : String(v);
}

/**
 * Read the first worksheet of the Excel log (read-only) and upsert each row
 * into `documents` keyed by IIS No. Rows without an IIS No. are skipped.
 * @returns {Promise<{inserted:number, updated:number, total:number}>}
 */
export async function reindex(db, excelPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(excelPath);
  const ws = wb.worksheets[0];

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO documents
      (iis_no, subject_name, company_name, address, emb_id, transaction_type, attachment_ref, source, first_seen, last_verified)
    VALUES (?,?,?,?,?,?,?, 'excel', ?, NULL)
    ON CONFLICT(iis_no) DO UPDATE SET
      subject_name=excluded.subject_name,
      company_name=excluded.company_name,
      address=excluded.address,
      emb_id=excluded.emb_id,
      transaction_type=excluded.transaction_type,
      attachment_ref=excluded.attachment_ref
  `);
  const exists = db.prepare('SELECT 1 FROM documents WHERE iis_no=?');

  let inserted = 0;
  let updated = 0;
  let total = 0;

  ws.eachRow((row, n) => {
    if (n === 1) return; // header
    const vals = COLS.map((_, i) => {
      const cell = row.getCell(i + 1).value;
      return i === 6 ? cellRef(cell) : cellText(cell);
    });
    const iisNo = vals[0].trim();
    if (!iisNo) return;
    total++;
    const had = exists.get(iisNo);
    upsert.run(iisNo, vals[1], vals[2], vals[3], vals[4], vals[5], vals[6], now);
    if (had) updated++;
    else inserted++;
  });

  return { inserted, updated, total };
}
