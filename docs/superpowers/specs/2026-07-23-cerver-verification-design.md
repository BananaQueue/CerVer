# CerVer — EMB Document Verification / Fetching System — Design

**Date:** 2026-07-23
**Status:** Approved design, pre-implementation
**Related brief:** `project_brief_EMB_document_verification.md`

## 1. Purpose

A web app for DENR EMB Region I that, given a scanned QR (or a manually entered
ID/token), retrieves and displays the authoritative details of an issued IIS
document so a person can confirm a printed/received copy is genuine. Goal scope:
**any EMB document that carries a QR code.**

## 2. Context that shapes the design

- CerVer has **no data of its own.** Its data source is the **IIS_Filer** project
  (`C:\Users\R1-MIS\Desktop\IIS_Filer`, Node.js + Playwright), which files IIS
  transactions using **Sir Lexter A. Galvez's PISMU account** (higher privilege
  than the user's search-only account) and logs each to
  `IIS_Transactions_Log.xlsx`.
- The "local database" is that Excel log, master-synced at
  `C:\Users\R1-MIS\OneDrive - Environmental Management Bureau\Lexter Galvez's files - IIS Transaction Logs\IIS_Transactions_Log.xlsx`.
  Columns: `IIS No. | Subject Name | Company Name | Address | EMB ID | Transaction Type | link to attachment`.
  Per-IIS-No. folders hold attachment PDFs.
- As of this design the log holds **323 rows, all enforcement/inspection docs**
  (NOTICE OF VIOLATION, ICIR, INVESTIGATION / MONITORING REPORT). The brief's
  named targets (Special Order, Travel Order, Accomplishment Report) are a
  **different population, not yet in the log.**
- **Future direction (user, 2026-07-23):** run IIS_Filer over ALL archived files
  reachable by Lexter's account to build a **complete** local DB. Therefore the
  local index is the strategic center of gravity; live IIS lookup is a fading
  backfill, not the hot path.

### ID / QR format variance (must be handled)
| Doc type | Sample ID | Shape |
|---|---|---|
| Special Order | `R1-2025-028799` | bare `R1-YYYY-NNNNNN` |
| Travel Order | `EMBR1-2025-030436` | `EMBR1-` prefix |
| Accomplishment Report | `13081688c1eb0a6ab8-69-2025-09-16-69-2025-09-30` | long hash token |
| (any) | `https://iis.emb.gov.ph/embis/dar/preview2/{token}` | full preview URL |

## 3. Chosen approach

**Approach A — Node.js, local-index-first, gated/throttled live-IIS backfill.**

Node (not the brief's Python/FastAPI) is chosen to **reuse IIS_Filer's working
Playwright session, OTP/login handling, and `exceljs`** for the live path — the
hardest part is already solved next door in Node.

- **Backend framework:** Fastify.
- **Index refresh:** on-demand / scheduled re-index (indexer run manually or after
  IIS_Filer runs). No live Excel reads per query; no file watcher.

## 4. Architecture

```
QR scan (browser camera) ──► decode payload
        │                        │
   manual entry ────────────────►│
                                 ▼
                    [ normalizer ] → { canonicalId, type, rawToken }
                                 ▼
                    GET /verify/:id
                                 ▼
                    [ localLookup → SQLite ]  ◄── indexer ← OneDrive Excel log
                         │            │
                    found│            │miss
                         ▼            ▼
                  Result card    [ iisLookup ]  (STAFF path only, throttled)
                  Verified ✅         via Lexter's Playwright session
                                      ├─ parse fields
                                      ├─ cache into SQLite (source=iis_live)
                                      └─ return  ── or ──► "No record found" ⚠️
```

## 5. Components (isolated, single-purpose)

- **`indexer`** — reads the Excel log read-only; upserts into `cerver.db`.
  Re-runnable and idempotent. Never writes to the Excel. Row → `documents` upsert
  keyed by `iis_no`.
- **`normalizer`** — pure function, no I/O. Absorbs all ID/QR format variance
  (bare code, `EMBR1-` prefix, hash token, full `preview2/{token}` URL) →
  `{ canonicalId, type, rawToken }`. The one place format chaos lives; heavily
  unit-tested.
- **`localLookup`** — canonical id → SQLite row or null. No IIS knowledge.
- **`iisLookup`** — id/token → drives Lexter's Playwright session to the
  transaction/preview page, parses fields, returns record or null. Isolated
  behind an interface so it is (a) swappable/patchable when IIS changes layout,
  (b) fakeable in tests. Throttled and queued (single-flight) to avoid hammering
  a shared government system.
- **`api`** (Fastify) — `GET /verify/:id`, `GET /health`. Orchestrates
  normalizer → localLookup → (staff-gated) iisLookup → cache → response.
- **`web`** — one mobile-first page: html5-qrcode scanner + manual entry box →
  `/verify` → result card.

## 6. Data model (`cerver.db`, SQLite)

**`documents`**
`iis_no` (PK) · `subject_name` · `company_name` · `address` · `emb_id` ·
`transaction_type` · `attachment_ref` · `source` (`excel` | `iis_live`) ·
`first_seen` · `last_verified`.
(Mirrors Excel columns 1:1 + provenance.)

**`verify_log`**
`id` · `ts` · `queried_id` · `resolved_iis_no` · `outcome`
(`local_hit` | `iis_hit` | `not_found`) · `path` (`public` | `staff`) ·
`client_hint`. Satisfies the brief's audit-logging requirement.

## 7. Result states

`Verified (local)` ✅ · `Verified (live IIS)` ✅ · `Not found` ⚠️ ·
`Needs staff lookup` (public miss requiring the gated live path) ·
`Error / unavailable`.

Active / Expired / Revoked / Superseded status **deferred** — the current data
exposes no such field. No fabricated status; add per doc type once a real source
field exists.

## 8. Access tiers (security gate)

- **Public path:** local index only. Miss → "Not found / request staff
  verification." Never touches IIS. No login. Safe to expose.
- **Staff path:** authenticated; a miss may trigger `iisLookup` (throttled,
  single-flight, cached). Keeps Lexter's privileged session off the public
  internet — addresses the brief's rate-limiting and policy concerns.

## 9. Build sequence (each step independently shippable)

1. `indexer` + `localLookup` + `/verify` + minimal web page — working end-to-end
   against the 323 rows.
2. `normalizer` with the 3 ID shapes + full URL + tests.
3. **Spike A:** decode the 3 sample QR images → confirm what each encodes (bare
   code vs `preview2/{token}` URL). **Spike B:** confirm Lexter's Playwright
   session reaches a fields-bearing page for one arbitrary IIS No.
4. `iisLookup` (staff-gated) + caching into `documents` + `verify_log`.
5. Polish scan UX, result/error states, throttle tuning.

## 10. Testing

- **`normalizer`** — TDD; exhaustive unit tests over the ID shapes (this is where
  format bugs hide).
- **`localLookup`** — unit tests against a fixture SQLite.
- **`indexer`** — tested against a small fixture `.xlsx`.
- **`iisLookup`** — behind an interface; API tested with a fake so the live path
  isn't required for CI. Live path validated manually via the spikes.

## 11. Open items to validate during implementation (not blocking)

1. Do the enforcement docs (NOV/ICIR) and the issued docs (SO/TO/AR) actually
   carry QR codes, and does the QR encode a bare control number or a
   `preview2/{token}` URL? (Spike A.)
2. Does Lexter's session, given an arbitrary IIS No., reach a page exposing
   verifiable authoritative fields? (Spike B.) Determines whether the live path
   is sufficient for verification or only partial.
3. Legal/procedural: confirm automated use of Lexter's account for on-demand
   verification is acceptable under EMB policy (already flagged for IIS_Filer).

## 12. Explicitly out of scope (YAGNI for now)

- Python/FastAPI rewrite.
- Public-facing live IIS lookups.
- Active/Expired/Revoked status logic.
- Auto file-watching / real-time Excel sync.
- Harvesting the IIS archive (that lives in IIS_Filer, feeding this DB over time).
