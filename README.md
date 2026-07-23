# CerVer — EMB Region I Document Verification

Scan the QR code on an EMB document (or type its control number) and instantly
see the authoritative record it was issued against. Built for DENR EMB Region I
to make cropped/pasted e-signatures easy to catch.

CerVer has two capabilities:

1. **Transaction verification** — QR / control-number lookup against the IIS
   registry (the "does this document exist" check the mother QR already does).
2. **Per-page sealing** — stamps every page of a signed PDF with a tamper-evident
   footer seal so multi-page **cut-and-paste** (swapping / inserting / removing /
   editing pages) is detectable. See "Per-page sealing" below.

## How it works

CerVer has no data of its own. It reads the **IIS transaction registry** produced
by the sibling **IIS_Filer** app (`Desktop\IIS_Filer`), which files IIS
transactions using Lexter A. Galvez's PISMU account and logs each to
`IIS_Transactions_Log.xlsx`.

```
QR / typed id ─► normalizer ─► local SQLite index ─► result
                                   │ (miss, STAFF only)
                                   └─► live IIS lookup ─► cache ─► result
```

- **Local-first.** A one-time/scheduled `reindex` loads the Excel registry into
  `cerver.db`. Lookups hit SQLite — fast, offline, safe to expose publicly.
- **Staff-gated live fallback.** When a document isn't in the local registry, a
  staff member can trigger a throttled live IIS lookup (reuses IIS_Filer's
  Playwright session). The public path never touches IIS.
- As the IIS archive is progressively filed into the registry, the local index
  trends toward complete and the live fallback becomes rare.

## Verification results

| Result | Meaning |
|---|---|
| **Verified — On record** | Matched in the local registry (green stamp) |
| **Verified — IIS live** | Confirmed against IIS just now and cached |
| **Check — Not in registry** | Not local yet; staff can run a live check. **Not** a fake |
| **No record** | Not found anywhere, including a live check. Treat with caution |
| **Unreadable** | Input isn't a valid EMB control number / QR |

## Per-page sealing (tamper-evidence for multi-page documents)

The mother QR proves a transaction exists but binds nothing about page contents,
so a forger can keep the genuine QR page and swap/insert/alter the others. CerVer
seals each page instead:

```
seal_k = base32( HMAC-SHA256( secret[kid], IIS_No ‖ k ‖ n ‖ SHA256(page text) ) )[0:8]
```

printed as a footer line: `EMB · R1-2026-010734 · p3/7 · K1 · 7F2A-9C41`. The
secret is server-only, so the seal is unforgeable; it binds the document, the
page position, and the page content.

**Workflow:** feed the FINAL signed PDF into CerVer (staff "Seal a document"
page) → it stamps every page and records each page's digest → the downloaded
sealed PDF is the copy that gets printed.

**Verification, three ways:**
- **Whole document** — QR / control-number lookup (transaction verification).
- **One page** — type/scan a page's footer seal → confirms the seal is authentic
  for page k of n. Staff can then open the authoritative page to compare content.
- **Full check** — upload the PDF → a page-by-page report that names exactly which
  pages were altered / inserted / removed / reordered (exact re-hash; no OCR).

Honest limit: from a printed page + phone photo, content edits can't be
auto-detected (OCR ≠ exact bytes) — detection there is authenticated
authoritative-content display + human comparison. The **Full check** (digital
PDF) path re-hashes exactly and is fully automatic.

### Seal key management

HMAC secrets are never stored in the DB. Set `CERVER_SEAL_KEYS` to a JSON map of
`kid -> secret` (e.g. `{"1":"<random-secret>"}`); the `kid` travels in each code
so keys can be rotated (add a new kid; old sealed docs still verify). A throwaway
dev key is used if the env var is unset — **set a real one in production.**

## Setup

```bash
npm install            # PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 recommended (uses system Chrome)
node bin/reindex.js    # load the Excel registry into cerver.db
npm start              # serve on http://localhost:3100
```

Open `http://localhost:3100/` on a phone (same network) to scan.

## Commands

| Command | Does |
|---|---|
| `npm start` | Run the Fastify server (`src/server.js`) |
| `npm test` | Run the full `node:test` suite |
| `node bin/reindex.js [path]` | (Re)build `cerver.db` from the Excel registry |

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `CERVER_EXCEL` | Lexter's OneDrive `IIS_Transactions_Log.xlsx` | Registry source (read-only) |
| `CERVER_DB` | `./cerver.db` | SQLite index path |
| `PORT` | `3100` | Server port |
| `CERVER_IIS_BASE` | `https://iis.emb.gov.ph` | IIS base URL for live lookup |
| `CERVER_IIS_PROFILE` | `profile` | Playwright profile dir for the staff live path |
| `CERVER_SEAL_KEYS` | dev key | JSON `{kid: secret}` for per-page seals (set in prod) |
| `CERVER_SEALED_DIR` | `./sealed` | where sealed PDFs are written |

## Layout

```
src/
  config.js         paths / settings (env-overridable)
  db.js             SQLite schema (documents, verify_log)
  normalizer.js     any QR payload -> canonical lookup key
  indexer.js        Excel -> SQLite upsert
  localLookup.js    canonical id -> row
  iisLookup.js      isolated, throttled live IIS lookup (patch scraping HERE)
  verifyService.js  orchestration + audit logging + staff gate
  app.js            Fastify routes
  server.js         entrypoint
bin/reindex.js      CLI indexer
public/             mobile scan + verify page
test/               node:test suite
docs/superpowers/   design spec + implementation plan
```

## Status & known gaps

- **Live IIS lookup is scaffolded, not yet validated.** `iisLookup.js` isolates
  the fragile scraping surface in `parseIisDocument`; field extraction beyond the
  IIS number is intentionally minimal until the real IIS page is observed
  (Spike B in the plan). Wire/verify against Lexter's session before relying on
  the staff path.
- **Hash-token documents** (e.g. Accomplishment Reports) aren't keyed by IIS No.,
  so they won't match the local index until that mapping is added.
- The registry currently covers enforcement/inspection transactions; other
  issued document types populate as IIS_Filer files them.
