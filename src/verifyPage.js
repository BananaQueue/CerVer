// Reading the IIS online verification page.
//
// Every EMB document carries a QR to https://iis.emb.gov.ph/verify/status?q=…
// The token in it is opaque — the control number is not in the QR, it is on the
// page the QR leads to. For a Special Order that matters, because the number is
// a blank in the document's own text ("No. 25- ______ Series of 2025") and is
// filled in only in IIS. The page is public: no session is needed.
//
// This is the fragile part. It reads a layout owned by another team, and it will
// break when they change it. Kept pure and separate for that reason: the
// captured page in test/verifyPage.test.js is what fails first and says so.

// Only R1-YYYY-NNNNNN can be carried by the mark. A page quoting anything else
// has not given us an answer we could seal with, so it is not an answer.
const IIS_NO = /^R1-(?:20|21)\d\d-\d{6}$/;

/** Value of a `Label : value` row, to the end of its line. */
function field(text, label) {
  const m = text.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, 'im'));
  return m ? m[1].trim() : null;
}

/**
 * @param {string|null|undefined} pageText visible text of the verification page
 * @returns {{iisNo: string, subject: string|null, status: string|null,
 *            division: string|null, companyName: string|null} | null}
 *   null when the page carries no transaction we could seal against.
 */
export function parseVerifyPage(pageText) {
  if (typeof pageText !== 'string' || !pageText.trim()) return null;

  const iisNo = field(pageText, 'IIS\\s*No\\.?');
  if (!iisNo || !IIS_NO.test(iisNo)) return null;

  return {
    iisNo,
    subject: field(pageText, 'Subject'),
    status: field(pageText, 'Status'),
    division: field(pageText, 'Division'),
    companyName: field(pageText, 'Company\\s*Name'),
  };
}
