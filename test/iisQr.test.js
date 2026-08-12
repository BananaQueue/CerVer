import test from 'node:test';
import assert from 'node:assert/strict';
import { isIisVerifyUrl } from '../src/iisQr.js';

// A QR in an uploaded PDF is untrusted: whoever supplies the document chooses
// what it points at. Only the configured IIS host is ever followed, so a crafted
// document cannot make the server fetch somewhere else.

const BASE = 'https://iis.emb.gov.ph';

test('follows the real document verification URL', () => {
  assert.equal(
    isIisVerifyUrl('https://iis.emb.gov.ph/verify/status?q=RYXkldcKn7t7zm3B0BhK4', BASE),
    true
  );
});

test('follows other paths on the same host', () => {
  assert.equal(isIisVerifyUrl('https://iis.emb.gov.ph/verify?id=R1-2026-010734', BASE), true);
});

test('refuses a different host', () => {
  assert.equal(isIisVerifyUrl('https://evil.example/verify/status?q=x', BASE), false);
});

test('refuses a look-alike host', () => {
  for (const u of [
    'https://iis.emb.gov.ph.evil.example/verify/status?q=x',
    'https://notiis.emb.gov.ph/verify/status?q=x',
    'https://iis-emb-gov-ph.example/verify/status?q=x',
  ]) {
    assert.equal(isIisVerifyUrl(u, BASE), false, u);
  }
});

test('refuses credentials embedded in the authority', () => {
  assert.equal(isIisVerifyUrl('https://iis.emb.gov.ph@evil.example/x', BASE), false);
});

test('refuses non-http schemes', () => {
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi']) {
    assert.equal(isIisVerifyUrl(u, BASE), false, u);
  }
});

test('refuses anything that is not a URL', () => {
  for (const u of ['', null, undefined, 'R1-2026-010734', 'not a url']) {
    assert.equal(isIisVerifyUrl(u, BASE), false, String(u));
  }
});

test('matches the host case-insensitively but not loosely', () => {
  assert.equal(isIisVerifyUrl('https://IIS.EMB.GOV.PH/verify/status?q=x', BASE), true);
});

test('honours a differently configured base', () => {
  const staging = 'https://iis-staging.emb.gov.ph';
  assert.equal(isIisVerifyUrl('https://iis-staging.emb.gov.ph/verify/status?q=x', staging), true);
  assert.equal(isIisVerifyUrl('https://iis.emb.gov.ph/verify/status?q=x', staging), false);
});
