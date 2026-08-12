import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { keyProvider as defaultKeyProvider } from './sealKeys.js';
import { createPageVerifier } from './pageVerifier.js';
import { formatFooter } from './sealCode.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(srcDir, '..', 'public');
const sealcodeDir = path.join(srcDir, 'sealcode');

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Build the Fastify app.
 * @param {object} deps
 * @param deps.db      SQLite handle
 * @param deps.verify  transaction verifier (createVerifier)
 * @param [deps.keyProvider] seal key provider (defaults to env-backed)
 * @param [deps.sealedDir]   where sealed PDFs are written
 */
export function buildApp({ db, verify, keyProvider, sealedDir, https, resolveQr }) {
  const app = Fastify({ logger: false, https });
  const keys = keyProvider || defaultKeyProvider();
  const sealDir = sealedDir || config.sealedDir;
  const pageVerify = createPageVerifier({ db, keyProvider: keys });

  app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  // `frameCapture` tells the page whether the diagnostic frame-save exists on
  // this deployment. The endpoint has always been gated by the environment, but
  // the button was not, so a counter clerk was offered a developer tool that
  // 404s. The page cannot read the server's environment, so it asks here.
  app.get('/health', async () => ({
    ok: true,
    frameCapture: process.env.CERVER_FRAME_CAPTURE === '1',
  }));

  // ---- Transaction verification (existing) ----
  app.get('/api/verify/:id', async (req) => {
    const staff = req.query.staff === '1' || req.query.staff === 'true';
    const hint = req.headers['user-agent'] ?? null;
    return verify(req.params.id, { path: staff ? 'staff' : 'public', clientHint: hint });
  });

  // ---- Single page-seal verification ----
  app.get('/api/verify-page', async (req) => {
    const input = req.query.line
      ? req.query.line
      : {
          iisNo: req.query.doc,
          k: Number(req.query.k),
          n: Number(req.query.n),
          kid: req.query.kid,
          seal: req.query.seal,
        };
    return pageVerify(input, {
      path: 'public',
      clientHint: req.headers['user-agent'] ?? null,
    });
  });

  // ---- Seal a document (staff): PDF in -> sealed PDF out ----
  // ---- Would the seal cover anything? ----
  //
  // Run before sealing, not after: once the sealed PDF has downloaded and gone
  // to the printer, a seal sitting on top of a signature is discovered by
  // whoever reads the paper.
  app.post('/api/seal-fit', async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'No file uploaded.' });
    const bytes = await data.toBuffer();
    const { checkSealFit, findClearSpot } = await import('./sealFit.js');
    const fit = await checkSealFit(bytes);
    // When the usual corner is taken, say where it could go instead rather than
    // leaving the only options as "cover it" or "give up".
    const moveTo = fit.clear ? null : (await findClearSpot(bytes)).spot;

    // Read the document's own control number off it. This is the field that
    // binds every page seal to a document, and a typo in it does not fail
    // loudly — it seals the pages under the wrong number. Confirming what the
    // document says beats transcribing it.
    let found = { best: null, candidates: [] };
    try {
      const { extractPageTexts } = await import('./pdfTools.js');
      const { detectControlNo } = await import('./controlNo.js');
      found = detectControlNo(await extractPageTexts(bytes));
    } catch {
      // A PDF whose text will not come out is not a reason to fail the
      // pre-flight: the QR is tried next, and the number can still be typed.
    }
    if (found.best) {
      return { ...fit, moveTo, iisNo: found.best, candidates: found.candidates, source: 'text', record: null, lookup: null };
    }

    // The text did not say. On a Special Order it never will — the number is a
    // blank there ("No. 25- ______") and lives only in IIS. The document's own
    // QR leads to a public page that states it, so ask that.
    let lookup = { ok: false, reason: 'not-tried' };
    try {
      const resolve = resolveQr || (await import('./iisQr.js')).resolveViaQr;
      const got = await resolve(bytes, { iisBaseUrl: config.iisBaseUrl });
      lookup = got?.ok
        ? { ok: true, reason: null, url: got.url }
        : { ok: false, reason: got?.reason || 'unreachable', detail: got?.detail || null };
      if (got?.ok) {
        return { ...fit, moveTo, iisNo: got.iisNo, candidates: [], source: 'iis', record: got.record, lookup };
      }
    } catch (e) {
      // Chrome absent, IIS unreachable, anything else — the pre-flight still has
      // a fit report to give, and the number can be typed.
      lookup = { ok: false, reason: 'unreachable', detail: String(e?.message || e).split('\n')[0] };
    }
    return { ...fit, moveTo, iisNo: null, candidates: found.candidates, source: null, record: null, lookup };
  });

  app.post('/api/seal', async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'No file uploaded.' });
    const iisNo = (data.fields?.iisNo?.value || '').trim();
    if (!iisNo) return reply.code(400).send({ error: 'iisNo is required.' });

    const pdfBytes = await data.toBuffer();
    // Where to put it. `at` is passed when the caller has already been shown the
    // collision and picked a spot; otherwise the usual corner is used.
    let at = null;
    const rawAt = data.fields?.at?.value;
    if (rawAt) {
      try {
        const p = JSON.parse(rawAt);
        if (Number.isFinite(p?.x0) && Number.isFinite(p?.y0)) at = { x0: p.x0, y0: p.y0 };
      } catch {
        return reply.code(400).send({ error: 'Bad seal position.' });
      }
    }

    const { sealPdf } = await import('./sealer.js');
    await fs.mkdir(sealDir, { recursive: true });
    const sealedPath = path.join(sealDir, `${safeName(iisNo)}.pdf`);
    const { sealedBytes, pages } = await sealPdf(db, {
      iisNo,
      pdfBytes,
      keyProvider: keys,
      sealedPdfPath: sealedPath,
      at,
    });
    await fs.writeFile(sealedPath, sealedBytes);

    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="sealed-${safeName(iisNo)}.pdf"`)
      .header('X-Sealed-Pages', String(pages.length));
    return reply.send(Buffer.from(sealedBytes));
  });

  // ---- Full document check (staff): upload PDF -> alteration report ----
  app.post('/api/verify-document', async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'No file uploaded.' });
    const expectedIisNo = (data.fields?.iisNo?.value || '').trim() || null;
    const pdfBytes = await data.toBuffer();
    const { verifyDocument } = await import('./docVerifier.js');
    return verifyDocument(db, pdfBytes, { keyProvider: keys, expectedIisNo });
  });

  // ---- Authoritative page preview (staff) ----
  app.get('/api/page-image', async (req, reply) => {
    const row = db
      .prepare('SELECT sealed_pdf_path FROM pages WHERE iis_no=? AND page_no=?')
      .get(req.query.doc, Number(req.query.k));
    if (!row || !row.sealed_pdf_path) {
      return reply.code(404).send({ error: 'No authoritative copy on file.' });
    }
    const bytes = await fs.readFile(row.sealed_pdf_path);
    const { extractSinglePage } = await import('./pdfTools.js');
    const single = await extractSinglePage(bytes, Number(req.query.k));
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', 'inline');
    return reply.send(Buffer.from(single));
  });

  // ---- What pages this document has on record ----
  //
  // A seal proves the page in hand belongs to the document, but it cannot tell
  // anyone holding paper WHAT the authoritative page says. The document QR is
  // the easy thing to scan, so it is the way in: from a control number, list
  // every sealed page with its printed seal code and page count, so the footer
  // line on the sheet can be checked by eye and the real page opened alongside.
  app.get('/api/pages/:iisNo', async (req) => {
    const iisNo = String(req.params.iisNo || '').trim();
    const rows = db
      .prepare(
        `SELECT page_no, total_pages, seal, kid, sealed_pdf_path
           FROM pages WHERE iis_no = ? ORDER BY page_no`
      )
      .all(iisNo);
    return {
      iisNo,
      total: rows.length ? rows[0].total_pages : 0,
      pages: rows.map((r) => ({
        k: r.page_no,
        n: r.total_pages,
        seal: r.seal,
        kid: r.kid,
        // The footer as it is printed, built by the same function the sealer
        // stamps with, so the two cannot drift apart. It is compared character
        // for character against the sheet.
        footer: formatFooter({
          iisNo, k: r.page_no, n: r.total_pages, kid: r.kid, seal: r.seal,
        }),
        hasImage: !!r.sealed_pdf_path,
      })),
    };
  });

  // pdf.js, straight out of node_modules rather than copied into public/, so the
  // served copy cannot fall behind the installed one. The page-reference view
  // renders the authoritative page with it.
  const pdfjsDir = path.join(srcDir, '..', 'node_modules', 'pdfjs-dist');
  app.register(fastifyStatic, {
    root: path.join(pdfjsDir, 'build'),
    prefix: '/vendor/pdfjs/',
    decorateReply: false,
  });
  // Sealed pages are typeset in the standard PDF fonts, which are NOT embedded in
  // the file — the viewer is expected to supply them. Without this pdf.js has
  // nothing to draw the text with and rendering never completes, silently.
  app.register(fastifyStatic, {
    root: path.join(pdfjsDir, 'standard_fonts'),
    prefix: '/vendor/pdfjs-fonts/',
    decorateReply: false,
  });

  // Serve the seal-code modules as ESM so the browser can decode a mark from
  // the camera with exactly the code the tests exercise — no second
  // implementation to drift.
  app.register(fastifyStatic, {
    root: sealcodeDir,
    prefix: '/sealcode/',
    decorateReply: false,
  });

  // Server-rendered seal code for a payload (handy for previews and printing).
  app.get('/api/sealcode.svg', async (req, reply) => {
    const payload = String(req.query.payload || '').trim();
    try {
      const { renderSvg } = await import('./sealcode/encode.js');
      const svg = renderSvg(payload, { px: Number(req.query.px) || 512 });
      reply.header('Content-Type', 'image/svg+xml; charset=utf-8');
      return reply.send(svg);
    } catch (e) {
      return reply.code(400).send({ error: String(e.message || e) });
    }
  });

  // ---- Diagnostic frame capture ----
  //
  // A scan that fails on paper looks the same from the outside as one that fails
  // for a completely different reason, and the phone doing the scanning is not
  // the machine the decoder is worked on. This lets a failing frame be kept, so
  // the decoder can be tested against the image the camera actually saw.
  //
  // Off unless CERVER_FRAME_CAPTURE=1 — it writes files to disk on request.
  // A diagnostic frame is a full-resolution PNG carried as a base64 data URL, so
  // the body runs well past fastify's 1 MiB default — which cut the upload off
  // mid-flight and left the phone's save button hanging rather than reporting an
  // error. Raised on this route alone; the rest of the API takes small JSON and
  // keeps the tight default. Sized so the 8 MB guard below is what actually
  // decides, base64 being 4/3 the size of the bytes it carries.
  app.post('/api/frame', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    if (process.env.CERVER_FRAME_CAPTURE !== '1') {
      return reply.code(404).send({ error: 'Frame capture is off.' });
    }
    const { image, info, ua } = req.body || {};
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
    if (!m) return reply.code(400).send({ error: 'Expected a PNG data URL.' });
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 8 * 1024 * 1024) return reply.code(413).send({ error: 'Frame too large.' });

    const dir = path.join(srcDir, '..', 'frames');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `frame-${stamp}.png`;
    await fs.writeFile(path.join(dir, file), buf);
    await fs.writeFile(
      path.join(dir, `frame-${stamp}.json`),
      JSON.stringify({ info: info ?? null, ua: ua ?? null, bytes: buf.length }, null, 2)
    );
    return { file, bytes: buf.length };
  });

  app.register(fastifyStatic, { root: publicDir, prefix: '/' });

  return app;
}
