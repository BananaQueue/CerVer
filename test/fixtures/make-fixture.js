import ExcelJS from 'exceljs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

export async function makeFixture(file = path.join(dir, 'sample.xlsx')) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Transactions');
  ws.addRow([
    'IIS No.',
    'Subject Name',
    'Company Name',
    'Address',
    'EMB ID',
    'Transaction Type',
    'link to attachment',
  ]);
  ws.addRow([
    'R1-2025-023099',
    'Inspection Report on Charcoal',
    'EMB R1',
    'San Fernando',
    'EMBR1-1053620-07',
    'INVESTIGATION REPORT',
    { text: 'R1-2025-023099', hyperlink: 'R1-2025-023099/' },
  ]);
  ws.addRow([
    'R1-2026-002465',
    'ICIR AQN Food Ventures',
    'EMB R1',
    'San Fernando',
    'EMBR1-1053620-07',
    'NOTICE OF VIOLATION',
    { text: 'R1-2026-002465', hyperlink: 'R1-2026-002465/' },
  ]);
  ws.addRow(['', 'row with no IIS no', '', '', '', '', '']);
  await wb.xlsx.writeFile(file);
  return file;
}
