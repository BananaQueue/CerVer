import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * Build the Fastify app. `verify` is the function from createVerifier.
 */
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
