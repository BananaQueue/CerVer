// Resolving a document's control number through the QR it already carries.
//
// Every EMB document has a QR to the IIS online verification page. The token in
// it is opaque, so the number cannot be read offline — but the page it leads to
// is public and states the IIS No. outright. That is the only way to get the
// number for a Special Order, whose own text leaves it blank.
//
// A real browser does the work, for two reasons. Rasterising a PDF page needs a
// canvas, and iis.emb.gov.ph serves an incomplete certificate chain that node's
// TLS stack rejects — a browser fetches the missing intermediate itself. The
// alternative, bundling that intermediate, breaks silently when the certificate
// is reissued (the current one expires 2026-12-05), and "IIS is down" is a poor
// way to discover it.
//
// The harness page is served to the browser from disk by request interception,
// so this does not depend on CerVer's own HTTP server being reachable.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseVerifyPage } from './verifyPage.js';

const HARNESS_ORIGIN = 'https://cerver.invalid';

/**
 * May this URL, taken from an uploaded document, be fetched?
 *
 * The QR is untrusted input: whoever supplies the PDF chooses where it points.
 * Only the configured IIS host is ever followed, so a crafted document cannot
 * turn the sealer into a fetcher for somewhere else.
 */
export function isIisVerifyUrl(url, base) {
  let u, b;
  try {
    u = new URL(String(url));
    b = new URL(String(base));
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  // Credentials in the authority are a classic way to make a URL read as one
  // host while resolving to another.
  if (u.username || u.password) return false;
  return u.hostname.toLowerCase() === b.hostname.toLowerCase();
}

/** Files the harness page needs, served from disk rather than over HTTP. */
async function harnessAssets(root) {
  const pdfjs = path.join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build');
  return {
    '/pdf.mjs': { type: 'text/javascript', body: await readFile(path.join(pdfjs, 'pdf.min.mjs')) },
    '/pdf.worker.mjs': { type: 'text/javascript', body: await readFile(path.join(pdfjs, 'pdf.worker.min.mjs')) },
    '/qr.js': {
      type: 'text/javascript',
      body: await readFile(path.join(root, 'public', 'vendor', 'html5-qrcode.min.js')),
    },
    '/harness.html': {
      type: 'text/html',
      body: Buffer.from(`<!doctype html><meta charset="utf-8"><body><div id="probe" hidden></div>
<script src="/qr.js"></script>
<script type="module">
  import * as pdfjs from '/pdf.mjs';
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';
  window.__render = async (bytes, pageNo, scale) => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    if (pageNo > doc.numPages) return null;
    const pg = await doc.getPage(pageNo);
    const vp = pg.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height;
    await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    return cv;
  };
  window.__pages = async (bytes) =>
    (await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise).numPages;
  window.__ready = true;
</script></body>`),
    },
  };
}

/** Scan a rendered page for a QR: whole page first, then overlapping tiles. */
/* c8 ignore start - runs inside the browser */
const SCAN_IN_PAGE = async ({ bytes, scale, maxPages }) => {
  const read = async (canvas) => {
    const q = new Html5Qrcode('probe', {
      formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
      verbose: false,
    });
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    try {
      return await q.scanFile(new File([blob], 'f.png', { type: 'image/png' }), false);
    } catch {
      return null;
    }
  };
  const sub = (cv, x, y, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(cv, x, y, w, h, 0, 0, w, h);
    return c;
  };

  const n = Math.min(await window.__pages(bytes), maxPages);
  for (let p = 1; p <= n; p++) {
    const cv = await window.__render(bytes, p, scale);
    if (!cv) break;
    const whole = await read(cv);
    if (whole) return { url: whole, page: p };
    // A small code on a big page is easy to miss whole, so sweep tiles.
    for (const div of [2, 3, 4]) {
      const tw = Math.ceil(cv.width / div), th = Math.ceil(cv.height / div);
      for (let gy = 0; gy < div * 2 - 1; gy++) {
        for (let gx = 0; gx < div * 2 - 1; gx++) {
          const x = Math.min(cv.width - tw, Math.floor((gx * tw) / 2));
          const y = Math.min(cv.height - th, Math.floor((gy * th) / 2));
          const got = await read(sub(cv, x, y, tw, th));
          if (got) return { url: got, page: p };
        }
      }
    }
  }
  return null;
};
/* c8 ignore stop */

/**
 * Read the document's QR and resolve it against IIS.
 *
 * @returns {Promise<{ok: true, iisNo: string, record: object, url: string, page: number}
 *                 | {ok: false, reason: 'no-qr'|'no-record'|'unreachable', detail?: string}>}
 */
export async function resolveViaQr(pdfBytes, opts = {}) {
  const {
    iisBaseUrl = 'https://iis.emb.gov.ph',
    root = process.cwd(),
    scale = 3,
    maxPages = 3, // the QR is on the first page in practice; do not grind through a long annex
    timeoutMs = 45000,
    chromium: injected = null,
  } = opts;

  let browser = null;
  try {
    const { chromium } = injected ? { chromium: injected } : await import('playwright');
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(timeoutMs);

    const assets = await harnessAssets(root);
    await page.route(`${HARNESS_ORIGIN}/**`, async (route) => {
      const hit = assets[new URL(route.request().url()).pathname];
      if (!hit) return route.fulfill({ status: 404, body: 'no' });
      return route.fulfill({ status: 200, contentType: hit.type, body: hit.body });
    });

    await page.goto(`${HARNESS_ORIGIN}/harness.html`);
    await page.waitForFunction(() => window.__ready);

    const found = await page.evaluate(SCAN_IN_PAGE, {
      bytes: Array.from(pdfBytes),
      scale,
      maxPages,
    });
    if (!found) return { ok: false, reason: 'no-qr' };
    if (!isIisVerifyUrl(found.url, iisBaseUrl)) {
      return { ok: false, reason: 'no-qr', detail: 'the QR does not point at IIS' };
    }

    // Wait for the field we need, not for the network to settle. Measured on the
    // real page: waiting for `load` or `networkidle` costs 21-22 s on something
    // we never read, where waiting for the record itself takes under a second.
    await page.goto(found.url, { waitUntil: 'domcontentloaded' });
    await page
      .waitForFunction(() => /IIS\s*No/i.test(document.body.innerText), null, { timeout: 15000 })
      .catch(() => {}); // no such row: let the parser below decide what that means
    const text = await page.evaluate(() => document.body.innerText);
    const record = parseVerifyPage(text);
    if (!record) return { ok: false, reason: 'no-record' };

    return { ok: true, iisNo: record.iisNo, record, url: found.url, page: found.page };
  } catch (e) {
    // Chrome missing, IIS unreachable, navigation timeout — all the same to the
    // person at the counter: it could not be looked up, so type it in.
    return { ok: false, reason: 'unreachable', detail: String(e?.message || e).split('\n')[0] };
  } finally {
    await browser?.close().catch(() => {});
  }
}
