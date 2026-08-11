// Render the sealed print test in a real browser and read every mark off the
// page: the document QR, the Data Matrix, and the EMB seal. Proves what a
// scanner would get from the printed sheet, short of the print itself.
//
//   node scripts/check-marks.mjs [pdf]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { readFile, mkdir, copyFile } from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const pdf = process.argv[2] || path.join(here, 'print-test-sealed.pdf');
const root = path.join(here, '..');

// pdf.js is served to the harness page rather than bundled, so make sure the
// copy in public/ is there before the browser asks for it.
const vendor = path.join(root, 'public', 'vendor', 'pdfjs');
await mkdir(vendor, { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  await copyFile(path.join(root, 'node_modules', 'pdfjs-dist', 'build', f), path.join(vendor, f));
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:3100/_render.html');
  await page.waitForFunction(() => window.__ready, null, { timeout: 30000 });

  const bytes = Array.from(await readFile(pdf));
  const results = await page.evaluate(async (bytes) => {
    const dec = await import('/sealcode/decode.js');
    const host = document.createElement('div');
    host.id = 'probe';
    host.hidden = true;
    document.body.appendChild(host);

    const readCode = async (canvas, format) => {
      const q = new Html5Qrcode('probe', {
        formatsToSupport: [Html5QrcodeSupportedFormats[format]],
        verbose: false,
      });
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      try {
        return await q.scanFile(new File([blob], 'f.png', { type: 'image/png' }), false);
      } catch {
        return null;
      }
    };

    // Cut a box out of the page, given in PDF points from the top-left.
    const crop = (cv, xPt, yPt, wPt, hPt, padPt) => {
      const S = cv.width / 595;
      const out = document.createElement('canvas');
      out.width = Math.round((wPt + padPt * 2) * S);
      out.height = Math.round((hPt + padPt * 2) * S);
      const cx = out.getContext('2d', { willReadFrequently: true });
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, out.width, out.height);
      cx.drawImage(
        cv,
        Math.round((xPt - padPt) * S), Math.round((yPt - padPt) * S),
        out.width, out.height, 0, 0, out.width, out.height
      );
      return out;
    };

    const SEAL = (22 / 25.4) * 72;
    const out = [];
    for (let p = 1; p <= 3; p++) {
      const cv = await window.__renderPage(bytes, p, 4);
      const sealCv = crop(cv, 595 - 84 - SEAL, 842 - 34 - SEAL, SEAL, SEAL, 8);
      const sx = sealCv.getContext('2d', { willReadFrequently: true });
      out.push({
        page: p,
        qr: await readCode(crop(cv, 595 - 56 - 62, 842 - 786, 62, 62, 8), 'QR_CODE'),
        dataMatrix: await readCode(crop(cv, 595 - 30 - 42, 842 - 82, 42, 42, 6), 'DATA_MATRIX'),
        seal: dec.inspect(sx.getImageData(0, 0, sealCv.width, sealCv.height)).payload,
      });
    }
    return out;
  }, bytes);

  let bad = 0;
  for (const r of results) {
    for (const k of ['qr', 'dataMatrix', 'seal']) {
      if (!r[k]) bad++;
      console.log(`page ${r.page}  ${k.padEnd(11)} ${r[k] ? r[k] : '*** UNREADABLE ***'}`);
    }
  }
  console.log(bad ? `\n${bad} mark(s) unreadable` : '\nall marks readable');
  process.exitCode = bad ? 1 : 0;
} finally {
  await browser.close();
}
