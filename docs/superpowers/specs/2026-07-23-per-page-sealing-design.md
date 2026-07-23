# CerVer — Per-Page Document Sealing — Design

**Date:** 2026-07-23
**Status:** Approved design, pre-implementation
**Extends:** `2026-07-23-cerver-verification-design.md`

## 1. Problem

The existing IIS QR ("mother QR") proves a *transaction exists* with certain
top-level metadata (subject, signatory, division, status). It does **not** bind
the document's page contents. On a multi-page document a third party can keep
the genuine QR page and **substitute, insert, remove, or reorder other pages**,
or move a genuine page into a forged document — undetectably, because the IIS
verification page shows only metadata, never the page body.

This project adds a **per-page seal** that binds each page to its document,
position, and content, making page-level tampering detectable.

## 2. Where this runs

**CerVer is the sealer.** The authoritative *signed* PDF is fed in (IIS_Filer
already archives these); the app stamps a per-page code and records each page's
digest; the **sealed PDF is the copy that gets printed/released.** No dependency
on MIS changing IIS. Sealing MUST happen on the final signed PDF — any later
edit changes the digests.

## 3. Guarantee & mechanism

For each page *k* of *n*:

```
digest_k = SHA256(canonical_text(page k))
seal_k   = base32( HMAC-SHA256( secret[kid], IIS_No ‖ k ‖ n ‖ digest_k ) )[0:8]
```

- `HMAC` with a server-only secret ⇒ a forger cannot mint a valid seal.
- Binds `IIS_No` (can't move a page to another doc), `k`/`n` (insert/remove/
  reorder break), and `digest_k` (content alteration breaks).
- `kid` = key id, embedded in the printed code, so the secret can be rotated.

### Honest limit (must be reflected in UX copy)
From a **printed page + phone photo**, content-alteration cannot be auto-detected
by re-hashing (OCR ≠ exact bytes). Detection works because: the genuine seal only
resolves to the genuine content, which the app **displays for the verifier to
compare** (staff path). A forger who edits a page can only keep the *genuine*
seal, which shows the *genuine* page on screen — exposing the edit. If
verification is ever done on the **digital sealed PDF**, re-hashing is exact and
fully automatic. Both paths are supported; the printed path is human-assisted.

## 4. The printed mark — type only (this phase)

An elegant footer reference line on every page, EMB green, e.g.:

```
EMB · R1-2026-010734 · p3/7 · K1 · 7F2A-9C41
```

Carries: `IIS_No`, page `k`, total `n`, key id `kid`, seal. Human-typeable and
OCR-friendly; no barcode/graphic this phase. (Generative "frond" emblem and an
optional Data Matrix are deferred — see §10.)

Canonical string parsed by the verifier: `R1-2026-010734|3|7|1|7F2A9C41`.

## 5. Sealing pipeline

```
signed PDF (upload)  ─►  for each page k of n:
    1. extract text(page k) via pdfjs-dist (legacy, text-only, no canvas)
    2. canonical = collapse-whitespace(text); if empty -> flag image-only page
    3. digest_k = sha256(canonical)
    4. seal_k   = hmac/base32 as in §3
    5. stamp footer line (pdf-lib) on page k
    6. upsert pages row (iis_no,k,n,digest_k,seal_k,kid,created_at)
 ─►  save sealed PDF (official released artifact) + keep source path
```

Driven by a **staff upload page**: drop the signed PDF, confirm/enter the
`IIS_No`, receive the sealed PDF for printing.

## 6. Verification (per page)

Endpoint: `GET /api/verify-page?doc=<iis>&k=<k>&n=<n>&kid=<kid>&seal=<seal>`

1. Look up `pages` row for `(iis_no, k)`. Missing ⇒ `not_sealed`.
2. Check `row.total_pages === n` and constant-time compare `row.seal === seal`
   (and recompute from `secret[kid]` + stored digest as defense in depth).
3. Result:
   - match ⇒ `page_verified`; **staff** path additionally serves the
     authoritative page (page *k* extracted from the sealed/archived PDF via
     pdf-lib) for side-by-side comparison; **public** path returns authenticity +
     `p k/n` only (no content — privacy).
   - seal mismatch ⇒ `page_tampered`.
   - `n` mismatch ⇒ `page_count_mismatch`.
4. Log to `verify_log` (reuse), `outcome` extended with the page states.

Reuses the existing **public/staff gate** from the base design for content
exposure.

## 7. Data model (additions to `cerver.db`)

**`pages`**
`iis_no` · `page_no` · `total_pages` · `digest` · `seal` · `kid` ·
`sealed_pdf_path` · `created_at`. Primary key `(iis_no, page_no)`.

**Secret handling**: HMAC secrets are NOT stored in the DB. `CERVER_SEAL_KEYS`
env holds `kid -> secret` (JSON); `kid` in the code selects the secret. Rotation
= add a new kid; old sealed docs still verify under their kid.

## 8. Frontend

New **"Verify a page"** mode on the existing page: enter/scan the footer code →
result card with `page_verified` / `page_tampered` / `page_count_mismatch` /
`not_sealed`, using the same rubber-stamp treatment (green / red / amber / slate).
Staff sees an embedded authoritative-page preview. A separate small **staff
"Seal a document"** upload view drives §5.

## 9. Tech

- `node:crypto` — HMAC-SHA256, SHA-256, timing-safe compare.
- `pdf-lib` — stamp footer text; extract a single page for authoritative preview.
- `pdfjs-dist` (legacy build) — per-page text extraction, no native canvas.
- All pure-JS; no new native builds.

## 10. Build sequence

1. `sealCode` module — pure: build/parse the canonical code, compute `digest`,
   `seal`, format/parse the printed line. TDD.
2. `pages` schema migration in `db.js`.
3. `sealer` — PDF text extract + digest + pdf-lib stamp + upsert; returns sealed
   PDF bytes. Test against a generated fixture PDF.
4. `verify-page` endpoint + `pageVerifier` service (states, gate, logging).
5. Authoritative-page extraction/preview (staff).
6. Frontend: "verify a page" mode + staff "seal a document" upload.
7. README + full test run.

## 11. Testing

- `sealCode`: exhaustive unit tests (build↔parse round-trip, digest stability
  under whitespace changes, seal changes when any bound field changes, timing-safe
  compare).
- `sealer`: fixture PDF in → assert N pages stamped, N rows stored, sealed PDF
  re-opens and its footers parse back to valid seals.
- `pageVerifier`: match / tamper (mutated digest) / n-mismatch / not-sealed;
  public vs staff content exposure.

## 12. Out of scope (this phase)

- Generative "frond" emblem and Data Matrix (design approved; deferred).
- Rasterized page thumbnails (serve extracted authoritative page instead).
- Automatic photo→hash tamper detection (fragile; human-assisted comparison
  instead).
- Anti-photocopy features (watermarks/holograms) — a true copy is not the threat
  here; tamper-evidence is.
