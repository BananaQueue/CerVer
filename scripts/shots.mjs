import { chromium } from 'playwright';

const base = 'http://localhost:3100/';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

async function shot(name) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `scripts/shot-${name}.png`, fullPage: true });
  console.log('shot', name);
}

await page.goto(base, { waitUntil: 'networkidle' });
await shot('1-initial');

// verified
await page.fill('#idInput', 'R1-2025-023099');
await page.click('#manualForm button[type=submit]');
await page.waitForSelector('.stamp');
await shot('2-verified');

// needs_staff
await page.click('#againBtn');
await page.fill('#idInput', 'R1-2099-000123');
await page.click('#manualForm button[type=submit]');
await page.waitForSelector('.stamp');
await shot('3-needs-staff');

// invalid
await page.click('#againBtn');
await page.fill('#idInput', 'hello world');
await page.click('#manualForm button[type=submit]');
await page.waitForSelector('.stamp');
await shot('4-invalid');

await browser.close();
console.log('done');
