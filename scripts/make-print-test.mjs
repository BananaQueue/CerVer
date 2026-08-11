// Build the print test document: a three-page EMB-style memo, laid out with the
// same margins and footer crowding a real permit has, so the seal has to survive
// being printed next to body text rather than on a blank sheet.
//
//   node scripts/make-print-test.mjs
//
// Writes scripts/print-test.pdf (unsealed). Seal it through the running server
// so the pages land in the same DB the scanner verifies against.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bwipjs from 'bwip-js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'print-test.pdf');
const PINE = rgb(0.043, 0.239, 0.18);
const IIS_NO = 'R1-2026-010734';

// Real EMB documents carry a QR that opens a verification page, and the whole
// design rests on the pair: the QR identifies the DOCUMENT, the seal proves the
// PAGE belongs to it. A test document without the QR only exercises half of it —
// and reads as a broken scanner to anyone pointing a plain QR reader at it.
const QR_URL = `https://iis.emb.gov.ph/verify?id=${IIS_NO}`;

const PAGES = [
  {
    heading: 'ENVIRONMENTAL COMPLIANCE CERTIFICATE',
    lines: [
      'This certifies that the proposed undertaking described below has been',
      'reviewed by the Environmental Management Bureau, Regional Office No. I,',
      'and is issued this Certificate subject to the conditions herein.',
      '',
      'Project        : Sample Aggregate Quarry and Processing Facility',
      'Proponent      : Northern Luzon Aggregates Corporation',
      'Location       : Barangay Poblacion, San Fernando City, La Union',
      'Capacity       : 120,000 metric tons per annum',
      'Classification : Category B — Environmentally Critical Area',
      '',
      'The Proponent shall implement the Environmental Management Plan submitted',
      'as part of the Initial Environmental Examination, and shall submit a',
      'Compliance Monitoring Report every six (6) months to this Office.',
      '',
      'This Certificate does not exempt the Proponent from securing other permits',
      'and clearances required by law, ordinance, or regulation.',
    ],
  },
  {
    heading: 'CONDITIONS OF THE CERTIFICATE',
    lines: [
      '1.  The Proponent shall confine all quarrying activity within the area',
      '    covered by the approved Mineral Production Sharing Agreement.',
      '',
      '2.  A settling pond of not less than 400 cubic metres shall be maintained',
      '    upstream of the discharge point at all times during operation.',
      '',
      '3.  Effluent shall conform to DENR Administrative Order 2016-08, Class C',
      '    inland water standards. Quarterly sampling shall be undertaken by a',
      '    DENR-recognized laboratory.',
      '',
      '4.  Ambient dust levels along the haul road shall not exceed 300 ug/Ncm',
      '    as a 24-hour average. Water spraying shall be conducted twice daily',
      '    during the dry season.',
      '',
      '5.  Rehabilitation of mined-out benches shall commence within one (1) year',
      '    of the cessation of extraction on each bench.',
      '',
      '6.  Any expansion, alteration, or change in the process described in the',
      '    application shall require a new or amended Certificate.',
    ],
  },
  {
    heading: 'MONITORING AND VALIDITY',
    lines: [
      'A Multipartite Monitoring Team shall be constituted within sixty (60) days',
      'from the issuance of this Certificate, with representation from the host',
      'barangay, the local government unit, and this Office.',
      '',
      'The Environmental Monitoring Fund and the Environmental Guarantee Fund',
      'shall be established in the amounts determined by the Team and shall be',
      'replenished annually.',
      '',
      'This Certificate shall remain valid for the entire lifetime of the project',
      'unless suspended or revoked for cause, after notice and hearing.',
      '',
      'Non-compliance with any condition stated herein shall be sufficient ground',
      'for the suspension or revocation of this Certificate, without prejudice to',
      'the fines and penalties provided under Presidential Decree 1586 and other',
      'applicable environmental laws.',
      '',
      '',
      '                                        NOEL A. VILLANUEVA, CESO IV',
      '                                        Regional Director',
    ],
  },
];

const doc = await PDFDocument.create();
const body = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const small = await doc.embedFont(StandardFonts.Helvetica);

const qrPng = await bwipjs.toBuffer({ bcid: 'qrcode', text: QR_URL, scale: 6 });
const qr = await doc.embedPng(qrPng);

for (const [i, { heading, lines }] of PAGES.entries()) {
  const p = doc.addPage([595, 842]); // A4
  const m = 56;

  // Letterhead
  p.drawText('Republic of the Philippines', { x: m, y: 790, size: 9, font: body, color: PINE });
  p.drawText('DEPARTMENT OF ENVIRONMENT AND NATURAL RESOURCES', {
    x: m, y: 776, size: 10, font: bold, color: PINE,
  });
  p.drawText('ENVIRONMENTAL MANAGEMENT BUREAU — REGIONAL OFFICE NO. I', {
    x: m, y: 763, size: 9, font: body, color: PINE,
  });
  p.drawLine({
    start: { x: m, y: 754 }, end: { x: 595 - m, y: 754 },
    thickness: 1.2, color: PINE,
  });

  // The document QR, upper right — where EMB puts it.
  const qrSize = 62; // pt, ~22 mm
  p.drawImage(qr, { x: 595 - m - qrSize, y: 786 - qrSize, width: qrSize, height: qrSize });

  p.drawText(heading, { x: m, y: 718, size: 12, font: bold });
  p.drawText(`Control No. ${IIS_NO}`, { x: m, y: 702, size: 9, font: small, color: PINE });

  let y = 672;
  for (const line of lines) {
    if (line) p.drawText(line, { x: m, y, size: 10, font: body });
    y -= 15;
  }

  // Footer furniture the seal has to share the corner with.
  p.drawLine({
    start: { x: m, y: 62 }, end: { x: 595 - m, y: 62 },
    thickness: 0.6, color: rgb(0.7, 0.72, 0.7),
  });
  p.drawText(`Page ${i + 1} of ${PAGES.length}`, { x: m, y: 48, size: 8, font: small });
  p.drawText('Government Center, Sevilla, San Fernando City, La Union 2500', {
    x: m, y: 36, size: 7, font: small, color: rgb(0.4, 0.44, 0.41),
  });
}

await writeFile(OUT, await doc.save());
console.log(`wrote ${OUT} — ${PAGES.length} pages, control no. ${IIS_NO}`);
