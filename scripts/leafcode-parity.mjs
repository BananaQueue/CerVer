// LeafCode browser parity proof.
//
// Every earlier gate (Gate A, Gate B) validated encode -> raster.js (a pure
// pixel test double) -> decode.js. That says nothing about whether the
// ACTUAL printable artwork -- src/leafcode/render.js's SVG output -- holds
// up once a real rasterizer (a browser, via <canvas> drawImage) turns it
// into pixels. This script is the proof that it does: it renders an SVG,
// loads it in real Chrome via Playwright, rasterizes it to a canvas at a
// known pixel size, reads back getImageData, and feeds those REAL browser
// pixels into decode(). If render.js's geometry ever drifts from raster.js
// (which decode.js's constants are tuned against), this is what would catch
// it -- a node-vs-node unit test comparing two numbers can't.
//
// Usage: node scripts/leafcode-parity.mjs
// Exit code 0 and "PARITY OK" on success; non-zero with diagnostics on any
// failure (including Chrome being unavailable -- that is reported as
// BLOCKED, not silently skipped, since the whole point of this script is to
// prove the real artwork decodes).

import { chromium } from 'playwright';
import { renderSvg } from '../src/leafcode/render.js';
import { encode } from '../src/leafcode/codec.js';
import { decode } from '../src/leafcode/decode.js';

// Same three known-good payloads supplied by the task controller: valid
// under the codec's base32 alphabet (ABCDEFGHIJKLMNOPQRSTUVWXYZ234567, no
// 0/1/8/9), pages 1-255, 6-digit serials.
const PAYLOADS = [
  'CVR|R1-2026-010734|3|TQQ3-MTBT',
  'CVR|R1-2025-023099|1|BDIN-YZNT',
  'CVR|R1-2026-091234|7|QDPV-NVOZ',
];

// Two distinct canvas sizes, matching the sizes already exercised by
// test/leafcode/raster.test.js and test/leafcode/gateB.test.js (1000 is the
// renderer's own default; 800 is the other size the rest of the suite
// checks geometry against).
const SIZES = [1000, 800];

// Rasterize an SVG string to RGBA pixels inside a real browser page: draw
// the SVG (via an <img> data: URL, which Chrome rasterizes with its own SVG
// engine -- not the pure-JS test double) onto a canvas at `size`x`size`,
// then read the pixels back with getImageData. Runs inside page.evaluate,
// so this whole function body executes in the browser, not in Node.
async function rasterizeSvgInBrowser(page, svg, size) {
  return await page.evaluate(
    async ({ svg, size }) => {
      const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
      const img = new Image();
      const loaded = new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('image failed to load'));
      });
      img.src = url;
      await loaded;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      // White backdrop first: PNG/canvas compositing of the SVG's own white
      // <rect> should already cover this, but an explicit fill guards
      // against any transparency surprises in Chrome's SVG rasterizer.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      const imageData = ctx.getImageData(0, 0, size, size);
      // Uint8ClampedArray isn't structured-clonable in a way page.evaluate
      // preserves as a typed array reliably across all Playwright versions;
      // ship it as a plain array of bytes and rebuild on the Node side.
      return { width: size, height: size, data: Array.from(imageData.data) };
    },
    { svg, size }
  );
}

async function main() {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (err) {
    console.error('BLOCKED: could not launch Chrome via Playwright.');
    console.error(String(err && err.stack ? err.stack : err));
    process.exitCode = 2;
    return;
  }

  try {
    const page = await browser.newPage();

    const results = [];
    let allOk = true;

    for (const payload of PAYLOADS) {
      const bits = encode(payload);
      for (const px of SIZES) {
        const svg = renderSvg(bits, { px });
        let got = null;
        let error = null;
        try {
          const raw = await rasterizeSvgInBrowser(page, svg, px);
          const img = { width: raw.width, height: raw.height, data: Uint8ClampedArray.from(raw.data) };
          got = decode(img);
        } catch (err) {
          error = err;
        }
        const ok = got === payload;
        allOk = allOk && ok;
        results.push({ payload, px, ok, got, error });
      }
    }

    console.log('=== LeafCode browser parity: SVG -> real Chrome raster -> decode() ===');
    for (const r of results) {
      const status = r.ok ? 'OK  ' : 'FAIL';
      console.log(`  [${status}] px=${r.px}  ${r.payload}`);
      if (!r.ok) {
        console.log(`           got: ${r.got === null ? 'null (no decode)' : JSON.stringify(r.got)}`);
        if (r.error) console.log(`           error: ${r.error.stack || r.error}`);
      }
    }

    if (!allOk) {
      console.error('\nPARITY FAILED: at least one SVG did not decode back to its payload after real-browser rasterization.');
      console.error('Diagnose whether render.js geometry (node/anchor radii, ring proportions) drifted from raster.js,');
      console.error('whether decoration is bleeding into a mark, or whether browser antialiasing at this size is');
      console.error('breaking dark/light classification. Fix render.js, not decode.js or raster.js.');
      process.exitCode = 1;
      return;
    }

    console.log(`\nAll ${results.length} cases (payloads x sizes) round-tripped through real Chrome rasterization.`);
    console.log('PARITY OK');
  } finally {
    await browser.close();
  }
}

await main();
