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

In the lower-right corner of each page it prints the **EMB seal code** — the
DENR/EMB logo pixelated to a 44×44 grid, carrying `CVR|iisNo|k|seal` in which
tiles keep their ink — with the human-readable seal line beneath it:
`EMB · R1-2026-010734 · p3/7 · K1 · TQQ3-MTBT`. The secret is server-only, so the
seal is unforgeable; it binds the document, the page position, and the page
content.

The mark carries 11 data bytes protected by 24 Reed-Solomon parity bytes, so up
to 12 of its 35 code bytes can come back wrong and still recover. That uses 280
of the 305 carrier tiles; it used to use 184 and leave the rest inked, doing
nothing. Measured over 20,000 simulated reads, with each carried bit misread at
3%, recovery went from 64.5% to 91.9% — see `node scripts/rs-bench.mjs`.

The mark is **16 mm** (0.36 mm per tile). It was 22 mm, settled by photographing
a printed calibration ladder: 18 mm read only sometimes, 22 mm read first time,
and ink spread was blamed for leaving no headroom below that.

That reading was wrong. The scanner was decoding a different region of the camera
frame than the preview displayed, so part of the mark was routinely cropped out
of the image being read — and small marks failed first, having least margin for a
crop nobody could see. The ladder measured a capture bug and reported it as a
property of the ink. With the capture region corrected, 14 mm reads; 16 mm keeps
a rung of margin.

The ladder has not been rephotographed since. 16 mm is one size confirmed by
hand, not a re-measured curve, and the real ink-spread limit is only known to sit
below 14 mm. Reprint the ladder (`node scripts/make-size-ladder.mjs`) before
going smaller.

**Diagnostics (off by default).** `CERVER_FRAME_CAPTURE=1` enables saving the
live scanner frame to `frames/` for offline analysis — how the pen-stroke
regression fixture was captured. It is a developer tool, so nothing about it is
shown unless it is switched on: `/health` reports `frameCapture`, and the page
only offers the button when the server says so. Without it the button never
appears and `/api/frame` is 404.

```bash
CERVER_FRAME_CAPTURE=1 npm start
```

**Workflow:** feed the FINAL signed PDF into CerVer (staff "Seal a document"
page) → its control number is read off the document and shown for confirmation →
it stamps every page and records each page's digest → the downloaded sealed PDF
is the copy that gets printed.

The control number is the field every page seal binds to, and a typo in it does
not fail loudly — it seals the pages under the wrong document. So it is read off
the document rather than typed, in two steps:

1. **The PDF's own text.** Free and offline. Works for documents that print
   their number, like `Control No. R1-2026-010734`.
2. **The QR the document already carries.** A Special Order leaves the number
   blank in its text (`No. 25- ______ Series of 2025`) — it exists only in IIS.
   The QR leads to a public verification page that states it. The token in the
   QR is opaque, so this needs a real fetch.

Only `R1-YYYY-NNNNNN` is looked for, being the only shape the mark can carry.
Either way the number is shown for confirmation with its evidence — where in the
text it was found, or the subject and division IIS returned — so that confirming
is a real check rather than a reflex. When neither answers, the field stays empty
and is filled in by hand; "could not reach IIS" is reported as itself, not as
"not found".

The QR step drives a headless Chrome (about 5 s), for two reasons: rasterising a
PDF page needs a canvas, and `iis.emb.gov.ph` serves an incomplete certificate
chain that node's TLS stack rejects while a browser resolves it. **A QR in an
uploaded document is untrusted input** — only the configured IIS host is ever
followed, so a crafted document cannot make the server fetch elsewhere.

Before stamping, the lower-right corner of every page is checked for anything the
seal would land on — text, images, drawn shapes — and sealing stops for
confirmation if it would cover something. A hairline rule crossing the corner is
reported separately and does not stop anything, since most letterheads have one.
Run it on any PDF with `node scripts/check-seal-fit.mjs <pdf>` (non-zero exit if
the seal would cover content).

**Verification.** Document-level checking is *not* CerVer's job — the QR already
on EMB documents does that, read by the phone's own camera, and it resolves to
the office's `iis.emb.gov.ph` page. CerVer covers the part that QR cannot:

- **One page** — scan the seal with the camera (or type control number + page +
  seal) → confirms the seal is authentic for page k of n, then shows the
  authoritative page beside it to compare the wording.
- **Full check** — upload the PDF → a page-by-page report that names exactly which
  pages were altered / inserted / removed / reordered (exact re-hash; no OCR).

**Photo of a page (off by default, pending calibration).** After a seal
verifies, `CERVER_PAGE_IMAGE_OCR=1` also offers "Attach a photo of this page",
checking every amount, date and duration on the record against what the
camera read. This is **evidence, not proof**: OCR is lossy, so a clean result
reads "nothing found", never "verified" — it narrows the honest limit below
without removing it. Spec §9.2 makes shipping it conditional on measuring the
comparison against real photographs first (not renders of the PDF), which has
not been done yet; until then the button does not exist on the page, same
gating as `CERVER_FRAME_CAPTURE` above.

```bash
CERVER_PAGE_IMAGE_OCR=1 npm start
```

Honest limit, and the reason the comparison view exists: **a valid seal read off
paper does not prove the words on that paper.** Verifying from a printed page
compares the printed seal against the registry; it cannot recompute the content
hash, because paper cannot be hashed. So the seal catches a page taken from
another document, a page in the wrong position, and a missing page — but not
retyped text. That is caught either by **Full check** on the digital PDF (exact,
automatic) or by a human comparing against the authoritative page the app
displays.

The photo check sits between those two. It is the human comparison done faster
and without skipping the digit that matters, not a third kind of proof.

### Seal key management

HMAC secrets are never stored in the DB. Set `CERVER_SEAL_KEYS` to a JSON map of
`kid -> secret` (e.g. `{"1":"<random-secret>"}`); the `kid` travels in each code
so keys can be rotated (add a new kid; old sealed docs still verify). A throwaway
dev key is used if the env var is unset — **set a real one in production.**

## Setup

```bash
npm install            # PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 recommended (uses system Chrome)
node bin/reindex.js    # load the Excel registry into cerver.db
npm run gen-cert       # once — self-signed cert so the camera works over the LAN
npm start
```

The server listens on **both**:
- `http://localhost:3100` — desktop / this machine (camera works: localhost is a
  secure context even over http). The in-app preview also uses this.
- `https://<LAN-IP>:3443` — phones / other devices. The camera needs HTTPS off
  localhost; accept the self-signed cert warning once. (HTTPS only appears if
  `npm run gen-cert` has been run.)

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
