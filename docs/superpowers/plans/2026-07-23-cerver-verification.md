# CerVer Verification System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js web app that verifies EMB IIS documents from a scanned QR / entered ID by looking them up in a local SQLite index (built from the IIS_Filer Excel log), with a staff-gated live-IIS fallback.

**Architecture:** Local-index-first. An `indexer` loads the OneDrive Excel log into SQLite. A pure `normalizer` turns any QR payload into a canonical lookup key. `verifyService` orchestrates normalizer → local lookup → (staff-gated, throttled) live-IIS lookup → cache. A Fastify API serves `/verify/:id` and a mobile-first scan page.

**Tech Stack:** Node.js 24, `node:sqlite` (built-in), `node:test` (built-in), Fastify, exceljs, Playwright (live path, reused from IIS_Filer), html5-qrcode (vendored, client-side).

## Global Constraints

- Node.js **24.x**; use built-in `node:sqlite` (`DatabaseSync`) and `node:test` — no `better-sqlite3`, no `vitest`.
- The Excel log is **read-only** to CerVer. Never open it for writing. Path: `C:\Users\R1-MIS\OneDrive - Environmental Management Bureau\Lexter Galvez's files - IIS Transaction Logs\IIS_Transactions_Log.xlsx` (overridable via config / env `CERVER_EXCEL`).
- Live-IIS lookup is **staff-path only**, single-flight, throttled. The public path never touches IIS.
- No fabricated document status (no Active/Expired/Revoked until a real source field exists).
- `documents` table mirrors Excel columns 1:1 plus provenance. SQLite file: `cerver.db` (gitignored).
- ESM modules (`"type": "module"` in package.json).

---

### Task 1: Project scaffold + config

**Files:**
- Create: `package.json`, `.gitignore`, `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `config` (default export object) with `{ excelPath, dbPath, port, iisBaseUrl }`, each overridable by env (`CERVER_EXCEL`, `CERVER_DB`, `PORT`, `CERVER_IIS_BASE`).

- [ ] **Step 1: Write `package.json`**
```json
{
  "name": "cerver",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "node --test",
    "reindex": "node bin/reindex.js",
    "start": "node src/server.js"
  },
  "dependencies": {
    "fastify": "^5.2.0",
    "@fastify/static": "^8.0.0",
    "exceljs": "^4.4.0",
    "playwright": "^1.49.0"
  }
}
```

- [ ] **Step 2: Write `.gitignore`**
```
node_modules/
cerver.db
cerver.db-*
profile/
*.log
```

- [ ] **Step 3: Write `src/config.js`**
```js
import path from 'node:path';

const DEFAULT_EXCEL = "C:\\Users\\R1-MIS\\OneDrive - Environmental Management Bureau\\Lexter Galvez's files - IIS Transaction Logs\\IIS_Transactions_Log.xlsx";

const config = {
  excelPath: process.env.CERVER_EXCEL || DEFAULT_EXCEL,
  dbPath: process.env.CERVER_DB || path.resolve('cerver.db'),
  port: Number(process.env.PORT || 3100),
  iisBaseUrl: process.env.CERVER_IIS_BASE || 'https://iis.emb.gov.ph',
};

export default config;
```

- [ ] **Step 4: Write `test/config.test.js`**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('config honors env overrides', async () => {
  process.env.CERVER_DB = '/tmp/x.db';
  process.env.PORT = '4000';
  const { default: config } = await import('../src/config.js?ovr=1');
  assert.equal(config.dbPath, '/tmp/x.db');
  assert.equal(config.port, 4000);
});
```

- [ ] **Step 5: Install deps and run test**
Run: `npm install && npm test`
Expected: config test passes.

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "feat: project scaffold and config"
```

---

### Task 2: Database module (schema)

**Files:**
- Create: `src/db.js`
- Test: `test/db.test.js`

**Interfaces:**
- Produces: `openDb(dbPath) -> DatabaseSync` — opens the SQLite file and ensures the `documents` and `verify_log` tables exist (idempotent).
  - `documents(iis_no PK, subject_name, company_name, address, emb_id, transaction_type, attachment_ref, source, first_seen, last_verified)`
  - `verify_log(id PK AUTOINCREMENT, ts, queried_id, resolved_iis_no, outcome, path, client_hint)`

- [ ] **Step 1: Write failing test `test/db.test.js`**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';

test('openDb creates documents and verify_log tables', () => {
  const db = openDb(':memory:');
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  assert.ok(tables.includes('documents'));
  assert.ok(tables.includes('verify_log'));
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test test/db.test.js`
Expected: FAIL (cannot find `../src/db.js`).

- [ ] **Step 3: Write `src/db.js`**
```js
import { DatabaseSync } from 'node:sqlite';

export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      iis_no           TEXT PRIMARY KEY,
      subject_name     TEXT,
      company_name     TEXT,
      address          TEXT,
      emb_id           TEXT,
      transaction_type TEXT,
      attachment_ref   TEXT,
      source           TEXT NOT NULL DEFAULT 'excel',
      first_seen       TEXT,
      last_verified    TEXT
    );
    CREATE TABLE IF NOT EXISTS verify_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            TEXT NOT NULL,
      queried_id    TEXT,
      resolved_iis_no TEXT,
      outcome       TEXT NOT NULL,
      path          TEXT NOT NULL,
      client_hint   TEXT
    );
  `);
  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `node --test test/db.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat: sqlite schema (documents, verify_log)"
```

---

### Task 3: Normalizer (pure ID/QR resolution)

**Files:**
- Create: `src/normalizer.js`
- Test: `test/normalizer.test.js`

**Interfaces:**
- Produces: `normalize(payload: string) -> { raw, kind, canonicalId, lookupKey }`
  - `kind`: `'iis_no' | 'token' | 'unknown'`
  - `iis_no`: bare `R1-YYYY-NNNNNN`, or `EMBR1-YYYY-NNNNNN` (canonicalized to `R1-YYYY-NNNNNN`). `canonicalId`/`lookupKey` = `R1-YYYY-NNNNNN`.
  - `token`: long hash token, or extracted last path segment of a `preview2/{token}` URL. `canonicalId`/`lookupKey` = the token.
  - `unknown`: anything else; `lookupKey` = trimmed input.

- [ ] **Step 1: Write failing tests `test/normalizer.test.js`**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalizer.js';

test('bare IIS number', () => {
  const r = normalize('R1-2025-028799');
  assert.equal(r.kind, 'iis_no');
  assert.equal(r.canonicalId, 'R1-2025-028799');
  assert.equal(r.lookupKey, 'R1-2025-028799');
});

test('EMBR1 prefixed travel-order number canonicalizes to R1', () => {
  const r = normalize('EMBR1-2025-030436');
  assert.equal(r.kind, 'iis_no');
  assert.equal(r.canonicalId, 'R1-2025-030436');
});

test('lowercase and whitespace tolerated', () => {
  const r = normalize('  r1-2026-009186 \n');
  assert.equal(r.kind, 'iis_no');
  assert.equal(r.canonicalId, 'R1-2026-009186');
});

test('hash token treated as token', () => {
  const t = '13081688c1eb0a6ab8-69-2025-09-16-69-2025-09-30';
  const r = normalize(t);
  assert.equal(r.kind, 'token');
  assert.equal(r.canonicalId, t);
});

test('preview2 URL extracts token', () => {
  const r = normalize('https://iis.emb.gov.ph/embis/dar/preview2/13081688c1eb0a6ab8-69-2025-09-16-69-2025-09-30');
  assert.equal(r.kind, 'token');
  assert.equal(r.canonicalId, '13081688c1eb0a6ab8-69-2025-09-16-69-2025-09-30');
});

test('URL containing a bare IIS number resolves to iis_no', () => {
  const r = normalize('https://iis.emb.gov.ph/embis/x/R1-2025-028799');
  assert.equal(r.kind, 'iis_no');
  assert.equal(r.canonicalId, 'R1-2025-028799');
});

test('empty input is unknown', () => {
  const r = normalize('   ');
  assert.equal(r.kind, 'unknown');
});
```

- [ ] **Step 2: Run tests to verify they fail**
Run: `node --test test/normalizer.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `src/normalizer.js`**
```js
const IIS_RE = /\b(?:EMB)?(R1)-((?:19|20)\d\d)-(\d{4,})\b/i;

export function normalize(payload) {
  const raw = payload == null ? '' : String(payload);
  let s = raw.trim();

  // If it's a URL, first try to pull an IIS number from anywhere in it;
  // otherwise use the last non-empty path segment as a token.
  let candidate = s;
  if (/^https?:\/\//i.test(s)) {
    const iisInUrl = s.match(IIS_RE);
    if (iisInUrl) {
      candidate = iisInUrl[0];
    } else {
      const segs = s.split('?')[0].split('#')[0].split('/').filter(Boolean);
      candidate = segs.length ? segs[segs.length - 1] : '';
    }
  }

  const m = candidate.match(IIS_RE);
  if (m) {
    const canonicalId = `${m[1].toUpperCase()}-${m[2]}-${m[3]}`;
    return { raw, kind: 'iis_no', canonicalId, lookupKey: canonicalId };
  }

  if (candidate && /[a-f0-9]{8,}/i.test(candidate) && candidate.length >= 12) {
    return { raw, kind: 'token', canonicalId: candidate, lookupKey: candidate };
  }

  const trimmed = candidate.trim();
  if (!trimmed) return { raw, kind: 'unknown', canonicalId: '', lookupKey: '' };
  return { raw, kind: 'unknown', canonicalId: trimmed, lookupKey: trimmed };
}
```

- [ ] **Step 4: Run tests to verify they pass**
Run: `node --test test/normalizer.test.js`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat: QR/ID normalizer with tests"
```

---

### Task 4: Indexer (Excel → SQLite)

**Files:**
- Create: `src/indexer.js`
- Test: `test/indexer.test.js`, `test/fixtures/make-fixture.js`

**Interfaces:**
- Consumes: `openDb` (Task 2).
- Produces: `reindex(db, excelPath) -> { inserted, updated, total }` — reads the first worksheet, upserts each row into `documents` keyed by `iis_no`, `source='excel'`. Sets `first_seen` on insert, always refreshes the other columns. Rows without an `IIS No.` are skipped.

- [ ] **Step 1: Write a fixture generator `test/fixtures/make-fixture.js`**
```js
import ExcelJS from 'exceljs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

export async function makeFixture(file = path.join(dir, 'sample.xlsx')) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Transactions');
  ws.addRow(['IIS No.', 'Subject Name', 'Company Name', 'Address', 'EMB ID', 'Transaction Type', 'link to attachment']);
  ws.addRow(['R1-2025-023099', 'Inspection Report on Charcoal', 'EMB R1', 'San Fernando', 'EMBR1-1053620-07', 'INVESTIGATION REPORT', { text: 'R1-2025-023099', hyperlink: 'R1-2025-023099/' }]);
  ws.addRow(['R1-2026-002465', 'ICIR AQN Food Ventures', 'EMB R1', 'San Fernando', 'EMBR1-1053620-07', 'NOTICE OF VIOLATION', { text: 'R1-2026-002465', hyperlink: 'R1-2026-002465/' }]);
  ws.addRow(['', 'row with no IIS no', '', '', '', '', '']);
  await wb.xlsx.writeFile(file);
  return file;
}
```

- [ ] **Step 2: Write failing test `test/indexer.test.js`**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { reindex } from '../src/indexer.js';
import { makeFixture } from './fixtures/make-fixture.js';

test('reindex loads rows, skips blank IIS no, and is idempotent', async () => {
  const file = await makeFixture();
  const db = openDb(':memory:');

  const first = await reindex(db, file);
  assert.equal(first.total, 2);
  assert.equal(first.inserted, 2);

  const row = db.prepare('SELECT * FROM documents WHERE iis_no=?').get('R1-2026-002465');
  assert.equal(row.transaction_type, 'NOTICE OF VIOLATION');
  assert.equal(row.attachment_ref, 'R1-2026-002465/');
  assert.equal(row.source, 'excel');

  const second = await reindex(db, file);
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 2);
  const count = db.prepare('SELECT COUNT(*) c FROM documents').get().c;
  assert.equal(count, 2);
});
```

- [ ] **Step 3: Run test to verify it fails**
Run: `node --test test/indexer.test.js`
Expected: FAIL (indexer missing).

- [ ] **Step 4: Write `src/indexer.js`**
```js
import ExcelJS from 'exceljs';

const COLS = ['iis_no', 'subject_name', 'company_name', 'address', 'emb_id', 'transaction_type', 'attachment_ref'];

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') return v.text ?? v.hyperlink ?? '';
  return String(v);
}
function cellRef(v) {
  if (v && typeof v === 'object') return v.hyperlink ?? v.text ?? '';
  return v == null ? '' : String(v);
}

export async function reindex(db, excelPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(excelPath);
  const ws = wb.worksheets[0];

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO documents (iis_no, subject_name, company_name, address, emb_id, transaction_type, attachment_ref, source, first_seen, last_verified)
    VALUES (?,?,?,?,?,?,?, 'excel', ?, NULL)
    ON CONFLICT(iis_no) DO UPDATE SET
      subject_name=excluded.subject_name,
      company_name=excluded.company_name,
      address=excluded.address,
      emb_id=excluded.emb_id,
      transaction_type=excluded.transaction_type,
      attachment_ref=excluded.attachment_ref
  `);
  const exists = db.prepare('SELECT 1 FROM documents WHERE iis_no=?');

  let inserted = 0, updated = 0, total = 0;
  ws.eachRow((row, n) => {
    if (n === 1) return; // header
    const vals = COLS.map((_, i) => {
      const cell = row.getCell(i + 1).value;
      return i === 6 ? cellRef(cell) : cellText(cell);
    });
    const iisNo = vals[0].trim();
    if (!iisNo) return;
    total++;
    const had = exists.get(iisNo);
    upsert.run(iisNo, vals[1], vals[2], vals[3], vals[4], vals[5], vals[6], now);
    if (had) updated++; else inserted++;
  });
  return { inserted, updated, total };
}
```

- [ ] **Step 5: Run test to verify it passes**
Run: `node --test test/indexer.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "feat: excel-to-sqlite indexer"
```

---

### Task 5: Local lookup

**Files:**
- Create: `src/localLookup.js`
- Test: `test/localLookup.test.js`

**Interfaces:**
- Produces: `localLookup(db, key) -> documentRow | null`. Queries `documents WHERE iis_no = key`. Pure read.

- [ ] **Step 1: Write failing test `test/localLookup.test.js`**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { localLookup } from '../src/localLookup.js';

test('localLookup returns row or null', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO documents (iis_no, subject_name, source, first_seen) VALUES ('R1-2025-1','Hello','excel','t')").run();
  assert.equal(localLookup(db, 'R1-2025-1').subject_name, 'Hello');
  assert.equal(localLookup(db, 'R1-2025-9'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test test/localLookup.test.js`
Expected: FAIL.

- [ ] **Step 3: Write `src/localLookup.js`**
```js
export function localLookup(db, key) {
  if (!key) return null;
  return db.prepare('SELECT * FROM documents WHERE iis_no = ?').get(key) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `node --test test/localLookup.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat: local lookup"
```

---

### Task 6: Verify service (orchestration + logging + gating)

**Files:**
- Create: `src/verifyService.js`
- Test: `test/verifyService.test.js`

**Interfaces:**
- Consumes: `normalize` (T3), `localLookup` (T5), an injected `iisLookup` fn (T7 shape: `async (norm) -> row|null`).
- Produces: `createVerifier({ db, iisLookup }) -> async verify(idOrToken, { path='public', clientHint=null }) -> result`
  - `result = { status, id: canonicalId, record: row|null }`
  - `status`: `'verified_local' | 'verified_live' | 'needs_staff' | 'not_found' | 'invalid'`
  - Flow: normalize → if kind unknown → `invalid`. localLookup hit → `verified_local`. Miss + `path==='staff'` → await iisLookup; hit → cache into `documents` (source `iis_live`, set `last_verified`) → `verified_live`; else `not_found`. Miss + `path==='public'` → `needs_staff`.
  - Always writes a `verify_log` row with outcome (`local_hit|iis_hit|not_found`) and path.

- [ ] **Step 1: Write failing tests `test/verifyService.test.js`**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createVerifier } from '../src/verifyService.js';

function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO documents (iis_no, subject_name, source, first_seen) VALUES ('R1-2025-028799','Special Order','excel','t')").run();
  return db;
}

test('local hit returns verified_local and logs', async () => {
  const db = seed();
  const verify = createVerifier({ db, iisLookup: async () => null });
  const r = await verify('R1-2025-028799');
  assert.equal(r.status, 'verified_local');
  assert.equal(r.record.subject_name, 'Special Order');
  const log = db.prepare('SELECT * FROM verify_log ORDER BY id DESC').get();
  assert.equal(log.outcome, 'local_hit');
  assert.equal(log.path, 'public');
});

test('public miss returns needs_staff and never calls iisLookup', async () => {
  const db = seed();
  let called = false;
  const verify = createVerifier({ db, iisLookup: async () => { called = true; return null; } });
  const r = await verify('R1-2099-000001', { path: 'public' });
  assert.equal(r.status, 'needs_staff');
  assert.equal(called, false);
});

test('staff miss consults iisLookup, caches hit, returns verified_live', async () => {
  const db = seed();
  const verify = createVerifier({ db, iisLookup: async (n) => ({ iis_no: n.canonicalId, subject_name: 'Live Doc' }) });
  const r = await verify('R1-2099-000002', { path: 'staff' });
  assert.equal(r.status, 'verified_live');
  const row = db.prepare('SELECT * FROM documents WHERE iis_no=?').get('R1-2099-000002');
  assert.equal(row.subject_name, 'Live Doc');
  assert.equal(row.source, 'iis_live');
});

test('invalid input returns invalid', async () => {
  const db = seed();
  const verify = createVerifier({ db, iisLookup: async () => null });
  const r = await verify('   ');
  assert.equal(r.status, 'invalid');
});
```

- [ ] **Step 2: Run tests to verify they fail**
Run: `node --test test/verifyService.test.js`
Expected: FAIL.

- [ ] **Step 3: Write `src/verifyService.js`**
```js
import { normalize } from './normalizer.js';
import { localLookup } from './localLookup.js';

export function createVerifier({ db, iisLookup }) {
  const logStmt = db.prepare(
    'INSERT INTO verify_log (ts, queried_id, resolved_iis_no, outcome, path, client_hint) VALUES (?,?,?,?,?,?)'
  );
  const cacheStmt = db.prepare(`
    INSERT INTO documents (iis_no, subject_name, company_name, address, emb_id, transaction_type, attachment_ref, source, first_seen, last_verified)
    VALUES (?,?,?,?,?,?,?, 'iis_live', ?, ?)
    ON CONFLICT(iis_no) DO UPDATE SET
      subject_name=excluded.subject_name, company_name=excluded.company_name,
      address=excluded.address, emb_id=excluded.emb_id,
      transaction_type=excluded.transaction_type, attachment_ref=excluded.attachment_ref,
      source='iis_live', last_verified=excluded.last_verified
  `);

  return async function verify(idOrToken, { path = 'public', clientHint = null } = {}) {
    const now = new Date().toISOString();
    const norm = normalize(idOrToken);

    if (norm.kind === 'unknown') {
      logStmt.run(now, norm.raw, null, 'not_found', path, clientHint);
      return { status: 'invalid', id: norm.canonicalId, record: null };
    }

    const hit = localLookup(db, norm.lookupKey);
    if (hit) {
      logStmt.run(now, norm.raw, hit.iis_no, 'local_hit', path, clientHint);
      return { status: 'verified_local', id: norm.canonicalId, record: hit };
    }

    if (path === 'staff') {
      const live = await iisLookup(norm);
      if (live) {
        cacheStmt.run(
          live.iis_no, live.subject_name ?? '', live.company_name ?? '', live.address ?? '',
          live.emb_id ?? '', live.transaction_type ?? '', live.attachment_ref ?? '', now, now
        );
        const record = db.prepare('SELECT * FROM documents WHERE iis_no=?').get(live.iis_no);
        logStmt.run(now, norm.raw, live.iis_no, 'iis_hit', path, clientHint);
        return { status: 'verified_live', id: norm.canonicalId, record };
      }
      logStmt.run(now, norm.raw, null, 'not_found', path, clientHint);
      return { status: 'not_found', id: norm.canonicalId, record: null };
    }

    logStmt.run(now, norm.raw, null, 'not_found', path, clientHint);
    return { status: 'needs_staff', id: norm.canonicalId, record: null };
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**
Run: `node --test test/verifyService.test.js`
Expected: PASS (4).

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat: verify service with gating and audit log"
```

---

### Task 7: Live IIS lookup (isolated, Playwright)

**Files:**
- Create: `src/iisLookup.js`
- Test: `test/iisLookup.test.js`

**Interfaces:**
- Produces: `createIisLookup({ iisBaseUrl, profileDir }) -> async (norm) -> row|null`. Single-flight + throttle wrapper `throttle(fn, minGapMs)`. The parsing of the IIS page is isolated in `parseIisDocument(pageText, norm)` (exported) so it can be unit-tested and patched without a browser.
- This task ships the **structure and the pure parser with tests**. The live Playwright navigation is validated manually (Spike B); its selectors are marked and isolated.

- [ ] **Step 1: Write failing test for the throttle + parser `test/iisLookup.test.js`**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { throttle } from '../src/iisLookup.js';

test('throttle serializes and spaces calls', async () => {
  const times = [];
  const fn = throttle(async (x) => { times.push(Date.now()); return x; }, 50);
  const [a, b] = await Promise.all([fn(1), fn(2)]);
  assert.equal(a, 1); assert.equal(b, 2);
  assert.ok(times[1] - times[0] >= 45, `gap was ${times[1]-times[0]}ms`);
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test test/iisLookup.test.js`
Expected: FAIL.

- [ ] **Step 3: Write `src/iisLookup.js`**
```js
// Live IIS lookup — ISOLATED so it can be patched when IIS changes layout.
// Reuses the same Playwright persistent profile as IIS_Filer (Lexter's session).

export function throttle(fn, minGapMs) {
  let chain = Promise.resolve();
  let last = 0;
  return (...args) => {
    chain = chain.then(async () => {
      const wait = Math.max(0, minGapMs - (Date.now() - last));
      if (wait) await new Promise(r => setTimeout(r, wait));
      last = Date.now();
      return fn(...args);
    });
    return chain;
  };
}

// Build the IIS preview/transaction URL for a normalized id/token.
export function iisUrlFor(norm, base) {
  if (norm.kind === 'token') return `${base}/embis/dar/preview2/${norm.canonicalId}`;
  return `${base}/embis/dms/documents/inbox?q=${encodeURIComponent(norm.canonicalId)}`;
}

// PARSE: pure function over already-extracted page text. Patch here if IIS changes.
export function parseIisDocument(pageText, norm) {
  if (!pageText || /no\s+record|not\s+found/i.test(pageText)) return null;
  return {
    iis_no: norm.kind === 'iis_no' ? norm.canonicalId : (pageText.match(/R1-(?:19|20)\d\d-\d{4,}/)?.[0] ?? norm.canonicalId),
    subject_name: '', company_name: '', address: '', emb_id: '',
    transaction_type: '', attachment_ref: '',
  };
}

export function createIisLookup({ iisBaseUrl, profileDir, minGapMs = 3000 }) {
  const raw = async (norm) => {
    const { chromium } = await import('playwright');
    const ctx = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false });
    try {
      const page = await ctx.newPage();
      await page.goto(iisUrlFor(norm, iisBaseUrl), { waitUntil: 'domcontentloaded', timeout: 60000 });
      const text = await page.locator('body').innerText();
      return parseIisDocument(text, norm);
    } finally {
      await ctx.close();
    }
  };
  return throttle(raw, minGapMs);
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `node --test test/iisLookup.test.js`
Expected: PASS.

- [ ] **Step 5: Add a parser unit test (record present / absent)**
```js
import { parseIisDocument } from '../src/iisLookup.js';
test('parseIisDocument returns null on not-found text', () => {
  assert.equal(parseIisDocument('No record found', { kind: 'iis_no', canonicalId: 'R1-2025-1' }), null);
});
test('parseIisDocument returns row when content present', () => {
  const r = parseIisDocument('Transaction R1-2025-028799 details ...', { kind: 'iis_no', canonicalId: 'R1-2025-028799' });
  assert.equal(r.iis_no, 'R1-2025-028799');
});
```

- [ ] **Step 6: Run and commit**
Run: `node --test test/iisLookup.test.js`
```bash
git add -A && git commit -m "feat: isolated live-IIS lookup (throttle + parser) with tests"
```

> **Spike B (manual, during execution):** run one real `createIisLookup(...)` call against a known IIS No. using the IIS_Filer profile dir; capture the actual page text; refine `parseIisDocument` selectors to extract real fields. Field extraction beyond `iis_no` is intentionally left minimal until the real page is observed.

---

### Task 8: Fastify API + server

**Files:**
- Create: `src/app.js` (buildApp factory), `src/server.js` (entrypoint)
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `openDb`, `createVerifier`, `createIisLookup`.
- Produces: `buildApp({ db, verify }) -> fastify` with routes:
  - `GET /health -> { ok: true }`
  - `GET /api/verify/:id?staff=1 -> result` (staff flag only honored server-side; default public)
  - static files from `public/` at `/`.

- [ ] **Step 1: Write failing test `test/app.test.js`**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createVerifier } from '../src/verifyService.js';
import { buildApp } from '../src/app.js';

test('GET /api/verify returns verified_local for seeded id', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO documents (iis_no, subject_name, source, first_seen) VALUES ('R1-2025-028799','Special Order','excel','t')").run();
  const verify = createVerifier({ db, iisLookup: async () => null });
  const app = buildApp({ db, verify });
  const res = await app.inject({ method: 'GET', url: '/api/verify/R1-2025-028799' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'verified_local');
  assert.equal(body.record.subject_name, 'Special Order');
  await app.close();
});

test('public miss is needs_staff', async () => {
  const db = openDb(':memory:');
  const verify = createVerifier({ db, iisLookup: async () => null });
  const app = buildApp({ db, verify });
  const res = await app.inject({ method: 'GET', url: '/api/verify/R1-2099-1' });
  assert.equal(res.json().status, 'needs_staff');
  await app.close();
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test test/app.test.js`
Expected: FAIL.

- [ ] **Step 3: Write `src/app.js`**
```js
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function buildApp({ db, verify }) {
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ ok: true }));
  app.get('/api/verify/:id', async (req) => {
    const staff = req.query.staff === '1' || req.query.staff === 'true';
    const hint = req.headers['user-agent'] ?? null;
    return verify(req.params.id, { path: staff ? 'staff' : 'public', clientHint: hint });
  });
  app.register(fastifyStatic, { root: publicDir, prefix: '/' });
  return app;
}
```

- [ ] **Step 4: Write `src/server.js`**
```js
import config from './config.js';
import { openDb } from './db.js';
import { createVerifier } from './verifyService.js';
import { createIisLookup } from './iisLookup.js';
import { buildApp } from './app.js';

const db = openDb(config.dbPath);
const iisLookup = createIisLookup({
  iisBaseUrl: config.iisBaseUrl,
  profileDir: process.env.CERVER_IIS_PROFILE || 'profile',
});
const verify = createVerifier({ db, iisLookup });
const app = buildApp({ db, verify });

app.listen({ port: config.port, host: '0.0.0.0' })
  .then(() => console.log(`CerVer listening on http://localhost:${config.port}`))
  .catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 5: Run test to verify it passes**
Run: `node --test test/app.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "feat: fastify api and server entrypoint"
```

---

### Task 9: Reindex CLI

**Files:**
- Create: `bin/reindex.js`

**Interfaces:**
- Consumes: `config`, `openDb`, `reindex`.
- Produces: a runnable script that indexes the configured Excel into the configured DB and prints counts.

- [ ] **Step 1: Write `bin/reindex.js`**
```js
import config from '../src/config.js';
import { openDb } from '../src/db.js';
import { reindex } from '../src/indexer.js';

const excel = process.argv[2] || config.excelPath;
const db = openDb(config.dbPath);
const res = await reindex(db, excel);
console.log(`Indexed ${res.total} rows from\n  ${excel}\n-> ${config.dbPath}\n  inserted=${res.inserted} updated=${res.updated}`);
```

- [ ] **Step 2: Run against the real Excel**
Run: `node bin/reindex.js`
Expected: prints `Indexed 323 rows ... inserted=323`.

- [ ] **Step 3: Commit**
```bash
git add -A && git commit -m "feat: reindex CLI"
```

---

### Task 10: Frontend scan page (apply superpowers frontend-design skill)

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/styles.css`
- Vendor: `public/vendor/html5-qrcode.min.js`

**Interfaces:**
- Consumes: `GET /api/verify/:id`.
- Produces: a mobile-first page — camera QR scan (html5-qrcode) + manual entry box → result card rendering the five verify statuses with clear, non-technical copy.

- [ ] **Step 1: Vendor the scanner library**
```bash
npm install html5-qrcode
mkdir -p public/vendor
cp node_modules/html5-qrcode/html5-qrcode.min.js public/vendor/html5-qrcode.min.js
```

- [ ] **Step 2: Invoke `frontend-design` skill** and build `index.html` + `styles.css` for the scan/verify page (mobile-first, EMB-appropriate, accessible; distinct result states for verified_local / verified_live / needs_staff / not_found / invalid). Theme-aware, no external fonts/CDNs.

- [ ] **Step 3: Write `public/app.js`** — wire html5-qrcode camera scan + manual form → `fetch('/api/verify/'+encodeURIComponent(id))` → render result card. On scan success, stop the camera and show the card; provide a "Scan another" reset.

- [ ] **Step 4: Manual verification**
Run: `npm start`, open `http://localhost:3100/`, enter `R1-2025-023099` → shows Verified (from the reindexed real DB); enter `R1-2099-1` → shows "Needs staff verification / not found".

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat: mobile scan/verify frontend"
```

---

### Task 11: README + full test run

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`** — what CerVer is, its relationship to IIS_Filer, how to `npm install`, `node bin/reindex.js`, `npm start`, `npm test`, env vars (`CERVER_EXCEL`, `CERVER_DB`, `PORT`, `CERVER_IIS_PROFILE`), and the public-vs-staff gate.
- [ ] **Step 2: Run the full suite** — `npm test` → all tests pass.
- [ ] **Step 3: Commit** — `git add -A && git commit -m "docs: readme"`.

---

## Self-Review

**Spec coverage:** §1 purpose → T8/T10. §2 data source → T4/T9. §3 Node/Fastify/local-first → all. §4 architecture → T6. §5 components → normalizer T3, indexer T4, localLookup T5, iisLookup T7, api T8, web T10. §6 data model → T2. §7 result states → T6 (5 statuses) + T10 rendering. §8 access tiers → T6 gating + T8 staff flag. §9 build sequence → task order. §10 testing → each task TDD. §11 spikes → T7 note (Spike B) + T10 real-data check; Spike A (decode sample QR) is a manual observation, folded into T10 verification. §12 out-of-scope respected (no status logic, no public live lookup).

**Placeholder scan:** live-IIS field extraction beyond `iis_no` is intentionally deferred to Spike B with the parser isolated — this is a documented, bounded unknown, not a placeholder. All code steps contain real code.

**Type consistency:** `normalize` returns `{raw,kind,canonicalId,lookupKey}` used consistently by verifyService and iisLookup. `verify` result `{status,id,record}` consumed by app.js. `reindex(db,path)->{inserted,updated,total}` consistent T4/T9. `openDb`, `localLookup`, `createVerifier`, `createIisLookup`, `buildApp` signatures match across tasks.
