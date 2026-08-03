import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { keyProvider as defaultKeyProvider } from './sealKeys.js';
import { createPageVerifier } from './pageVerifier.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(srcDir, '..', 'public');
const leafcodeDir = path.join(srcDir, 'leafcode');

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
export function buildApp({ db, verify, keyProvider, sealedDir, https }) {
  const app = Fastify({ logger: false, https });
  const keys = keyProvider || defaultKeyProvider();
  const sealDir = sealedDir || config.sealedDir;
  const pageVerify = createPageVerifier({ db, keyProvider: keys });

  app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  app.get('/health', async () => ({ ok: true }));

  // ---- Transaction verification (existing) ----
  app.get('/api/verify/:id', async (req) => {
    const staff = req.query.staff === '1' || req.query.staff === 'true';
    const hint = req.headers['user-agent'] ?? null;
    return verify(req.params.id, { path: staff ? 'staff' : 'public', clientHint: hint });
  });

  // ---- Single page-seal verification ----
  app.get('/api/verify-page', async (req) => {
    const staff = req.query.staff === '1' || req.query.staff === 'true';
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
      path: staff ? 'staff' : 'public',
      clientHint: req.headers['user-agent'] ?? null,
    });
  });

  // ---- Seal a document (staff): PDF in -> sealed PDF out ----
  app.post('/api/seal', async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'No file uploaded.' });
    const iisNo = (data.fields?.iisNo?.value || '').trim();
    if (!iisNo) return reply.code(400).send({ error: 'iisNo is required.' });

    const pdfBytes = await data.toBuffer();
    const requested = (data.fields?.mark?.value || 'datamatrix').trim();
    const mark = ['datamatrix', 'sealcode', 'leafcode', 'both'].includes(requested) ? requested : 'datamatrix';
    const { sealPdf } = await import('./sealer.js');
    await fs.mkdir(sealDir, { recursive: true });
    const sealedPath = path.join(sealDir, `${safeName(iisNo)}.pdf`);
    const { sealedBytes, pages } = await sealPdf(db, {
      iisNo,
      pdfBytes,
      keyProvider: keys,
      sealedPdfPath: sealedPath,
      mark,
    });
    await fs.writeFile(sealedPath, sealedBytes);

    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="sealed-${safeName(iisNo)}.pdf"`)
      .header('X-Sealed-Pages', String(pages.length))
      .header('X-Sealed-Mark', mark);
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

  // LeafCode (experimental): serve the modules as ESM so the browser can render
  // and decode a LeafCode client-side. Read-only static JS; not part of the
  // production verification path.
  app.register(fastifyStatic, {
    root: leafcodeDir,
    prefix: '/leafcode/',
    decorateReply: false,
  });

  // Server-rendered LeafCode SVG for a payload.
  app.get('/api/leafcode.svg', async (req, reply) => {
    const payload = String(req.query.payload || '').trim();
    try {
      const [{ encode }, { renderSvg }] = await Promise.all([
        import('./leafcode/codec.js'),
        import('./leafcode/render.js'),
      ]);
      const svg = renderSvg(encode(payload), { px: Number(req.query.px) || 1000 });
      reply.header('Content-Type', 'image/svg+xml; charset=utf-8');
      return reply.send(svg);
    } catch (e) {
      return reply.code(400).send({ error: String(e.message || e) });
    }
  });

  app.register(fastifyStatic, { root: publicDir, prefix: '/' });

  return app;
}
