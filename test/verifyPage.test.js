import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerifyPage } from '../src/verifyPage.js';

// Captured verbatim from https://iis.emb.gov.ph/verify/status?q=... for a real
// Special Order on 2026-08-12. This is the scraping surface: when IIS changes
// its layout, this fixture is what should be updated first, and the failure
// here is the warning.
const REAL = `ENVIRONMENTAL MANAGEMENT BUREAU
ONLINE DOCUMENT VERIFICATION
VERIFIED IIS TRANSACTION
IIS No\t:\tR1-2025-025065
Company EMB ID\t:\tEMBR1-1053620-07
Company Name\t:\tENVIRONMENTAL MANAGEMENT BUREAU - REGION I ( ILOCOS )
Subject\t:\tAUTHORIZING THE CONDUCT OF 2026 ANNUAL GAD PLANNING AND BUDGETING WORKSHOP, PROGRAM ASSESSMENT (GMEF)
Status\t:\tActive
Action\t:\tFor information/guidance/reference.
Division\t:\tR1 - Environmental Monitoring and Enforcement Division
as of August 12, 2026, 1:57 PM`;

test('reads the control number off a real verification page', () => {
  assert.equal(parseVerifyPage(REAL).iisNo, 'R1-2025-025065');
});

test('reads the fields a person needs to check the document by', () => {
  const got = parseVerifyPage(REAL);
  assert.equal(got.status, 'Active');
  assert.equal(got.division, 'R1 - Environmental Monitoring and Enforcement Division');
  assert.match(got.subject, /^AUTHORIZING THE CONDUCT OF 2026 ANNUAL GAD/);
  assert.equal(got.companyName, 'ENVIRONMENTAL MANAGEMENT BUREAU - REGION I ( ILOCOS )');
});

test('a value stops at its own line', () => {
  // "Status" must not swallow the "Action" line that follows it.
  assert.equal(parseVerifyPage(REAL).status, 'Active');
});

test('returns null when the page carries no transaction', () => {
  assert.equal(parseVerifyPage('ONLINE DOCUMENT VERIFICATION\nNo record found.'), null);
  assert.equal(parseVerifyPage(''), null);
  assert.equal(parseVerifyPage(null), null);
});

test('returns null when the number is not a shape the mark can carry', () => {
  // Anything the sealer would refuse is not an answer worth returning.
  assert.equal(parseVerifyPage('IIS No\t:\t25-506\nStatus\t:\tActive'), null);
});

test('tolerates spacing instead of tabs', () => {
  const got = parseVerifyPage('IIS No :  R1-2025-025065\nStatus :  Active');
  assert.equal(got.iisNo, 'R1-2025-025065');
  assert.equal(got.status, 'Active');
});

test('missing optional fields do not break the read', () => {
  const got = parseVerifyPage('IIS No\t:\tR1-2025-025065');
  assert.equal(got.iisNo, 'R1-2025-025065');
  assert.equal(got.subject, null);
  assert.equal(got.status, null);
});
