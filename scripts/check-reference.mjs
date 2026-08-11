// Drive the real page-verification flow in a real browser and prove the
// cross-reference view renders: fill the seal, verify, open the comparison, and
// confirm the authoritative page actually painted.
//
//   node scripts/check-reference.mjs
//
// This has to run somewhere that composites frames — pdf.js drives canvas
// rendering from requestAnimationFrame, which never fires in a hidden tab.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const shot = path.join(here, 'reference-view.png');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 1200 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('http://localhost:3100/', { waitUntil: 'networkidle' });

  // manual entry is folded away now — scanning is the normal path
  await page.evaluate(() => { document.getElementById('fold').open = true; });
  await page.fill('#pgDoc', 'R1-2026-010734');
  await page.fill('#pgK', '2');
  await page.fill('#pgSeal', 'VWHF-AS2V');
  await page.click('#pageForm button[type=submit]');

  await page.waitForSelector('#compareBtn', { timeout: 15000 });
  const stamp = (await page.textContent('.stamp')).replace(/\s+/g, ' ').trim();
  const listed = await page.$$eval('.pages .sealtxt', (n) =>
    n.map((e) => e.textContent.replace(/\s+/g, ' ').trim())
  );
  const here2 = await page.textContent('.pages li.here .pk');

  await page.click('#compareBtn');
  await page.waitForSelector('#refStage canvas', { timeout: 30000 });
  const canvas = await page.$eval('#refStage canvas', (c) => ({ w: c.width, h: c.height }));

  // Not just present — actually painted. A blank canvas would pass a selector check.
  const painted = await page.$eval('#refStage canvas', (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200) ink++;
    return { darkPixels: ink, fraction: +(ink / (c.width * c.height)).toFixed(4) };
  });

  await page.click('#refZoomIn');
  await page.waitForTimeout(700);
  const zoom = await page.textContent('#refZoom');

  await page.screenshot({ path: shot, fullPage: true });

  console.log('verdict stamp   :', stamp);
  console.log('page highlighted:', here2);
  console.log('seals listed    :');
  for (const f of listed) console.log('   ', f);
  console.log('rendered canvas :', `${canvas.w}x${canvas.h}`);
  console.log('painted ink     :', painted.darkPixels, `px (${(painted.fraction * 100).toFixed(2)}%)`);
  console.log('zoom after +    :', zoom);
  console.log('console errors  :', errors.length ? errors.join(' | ') : 'none');
  console.log('screenshot      :', shot);

  if (!painted.darkPixels) {
    console.error('\nFAIL: the reference canvas is blank.');
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
