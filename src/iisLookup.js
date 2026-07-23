// Live IIS lookup — ISOLATED so it can be patched when IIS changes layout.
// Reuses the same Playwright persistent profile as IIS_Filer (Lexter's session).
// Only ever called on the STAFF path, throttled and single-flight.

/**
 * Serialize calls and enforce a minimum gap between them so we never hammer
 * the shared IIS system.
 */
export function throttle(fn, minGapMs) {
  let chain = Promise.resolve();
  let last = 0;
  return (...args) => {
    const run = chain.then(async () => {
      const wait = Math.max(0, minGapMs - (Date.now() - last));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn(...args);
    });
    // Keep the chain alive even if this call rejects.
    chain = run.then(() => {}, () => {});
    return run;
  };
}

/** Build the IIS URL to visit for a normalized id/token. */
export function iisUrlFor(norm, base) {
  if (norm.kind === 'token') return `${base}/embis/dar/preview2/${norm.canonicalId}`;
  return `${base}/embis/dms/documents/inbox?q=${encodeURIComponent(norm.canonicalId)}`;
}

/**
 * PARSE: pure function over already-extracted page text. This is the fragile
 * scraping surface — patch selectors/extraction HERE when IIS changes layout.
 * Extraction beyond iis_no is intentionally minimal until the real page is
 * observed (see Spike B in the plan).
 */
export function parseIisDocument(pageText, norm) {
  if (!pageText || /no\s+record|not\s+found/i.test(pageText)) return null;
  const iisNo =
    norm.kind === 'iis_no'
      ? norm.canonicalId
      : pageText.match(/R1-(?:19|20)\d\d-\d{4,}/)?.[0] ?? norm.canonicalId;
  return {
    iis_no: iisNo,
    subject_name: '',
    company_name: '',
    address: '',
    emb_id: '',
    transaction_type: '',
    attachment_ref: '',
  };
}

/**
 * Create the live lookup fn. Lazily imports Playwright so unit tests that only
 * exercise throttle/parse never need a browser.
 */
export function createIisLookup({ iisBaseUrl, profileDir, minGapMs = 3000 }) {
  const raw = async (norm) => {
    const { chromium } = await import('playwright');
    const ctx = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: false,
    });
    try {
      const page = await ctx.newPage();
      await page.goto(iisUrlFor(norm, iisBaseUrl), {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      const text = await page.locator('body').innerText();
      return parseIisDocument(text, norm);
    } finally {
      await ctx.close();
    }
  };
  return throttle(raw, minGapMs);
}
