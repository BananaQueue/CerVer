import { extractPageTexts } from './pdfTools.js';
import { parseFooter, stripFooter, digestPage, computeSeal, sealsEqual } from './sealCode.js';

// Whole-document check: recompute each page's digest from its ACTUAL content and
// compare to the printed seal. Because the seal is an HMAC a forger can't forge,
// any body edit makes the recomputed seal disagree with the printed one → the
// exact altered page is named. Structural checks catch inserted / missing /
// reordered / foreign pages.

function mode(values) {
  const count = new Map();
  let best = null;
  let bestN = 0;
  for (const v of values) {
    const c = (count.get(v) || 0) + 1;
    count.set(v, c);
    if (c > bestN) {
      bestN = c;
      best = v;
    }
  }
  return best;
}

export async function verifyDocument(db, pdfBytes, { keyProvider, expectedIisNo = null } = {}) {
  const texts = await extractPageTexts(pdfBytes);
  const actualPages = texts.length;

  const pages = texts.map((t, i) => {
    const position = i + 1;
    const parsed = parseFooter(t);
    if (!parsed) return { position, status: 'not_sealed' };

    const digest = digestPage(stripFooter(t));
    let contentOk = false;
    try {
      const secret = keyProvider.secretFor(parsed.kid);
      const expected = computeSeal(secret, {
        iisNo: parsed.iisNo,
        k: parsed.k,
        n: parsed.n,
        digest,
      });
      contentOk = sealsEqual(expected, parsed.seal);
    } catch {
      contentOk = false; // unknown kid
    }
    return {
      position,
      iisNo: parsed.iisNo,
      claimedK: parsed.k,
      claimedN: parsed.n,
      seal: parsed.seal,
      status: contentOk ? 'verified' : 'content_altered',
    };
  });

  const sealed = pages.filter((p) => p.status !== 'not_sealed');
  const docIisNo = expectedIisNo || mode(sealed.map((p) => p.iisNo)) || null;
  const claimedN = mode(sealed.filter((p) => p.iisNo === docIisNo).map((p) => p.claimedN)) || null;

  const findings = [];
  const seenK = new Set();
  for (const p of pages) {
    if (p.status === 'not_sealed') {
      findings.push(`Page at position ${p.position} carries no seal (inserted or unsealed).`);
      continue;
    }
    if (docIisNo && p.iisNo !== docIisNo) {
      findings.push(`Page ${p.position} belongs to a different document (${p.iisNo}).`);
    }
    if (p.status === 'content_altered') {
      findings.push(`Page ${p.position} (page ${p.claimedK}) content was altered.`);
    }
    if (p.claimedK !== p.position) {
      findings.push(`Page ${p.position} is out of order (claims to be page ${p.claimedK}).`);
    }
    if (seenK.has(p.claimedK)) findings.push(`Page ${p.claimedK} is duplicated.`);
    seenK.add(p.claimedK);
  }
  if (claimedN != null) {
    for (let k = 1; k <= claimedN; k++) {
      if (!seenK.has(k)) findings.push(`Page ${k} of ${claimedN} is missing.`);
    }
    if (actualPages !== claimedN) {
      findings.push(`Document should have ${claimedN} pages but has ${actualPages}.`);
    }
  }

  const status = findings.length === 0 && sealed.length === actualPages ? 'intact' : 'tampered';

  if (db) {
    db.prepare(
      'INSERT INTO verify_log (ts, queried_id, resolved_iis_no, outcome, path, client_hint) VALUES (?,?,?,?,?,?)'
    ).run(new Date().toISOString(), docIisNo, docIisNo, `document_${status}`, 'staff', null);
  }

  return {
    document: { iisNo: docIisNo, claimedPages: claimedN, actualPages, status },
    pages,
    findings,
  };
}
