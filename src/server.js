import fs from 'node:fs';
import config from './config.js';
import { openDb } from './db.js';
import { createVerifier } from './verifyService.js';
import { createIisLookup } from './iisLookup.js';
import { keyProvider } from './sealKeys.js';
import { buildApp } from './app.js';

// Serve HTTPS when certs/ exists (run `npm run gen-cert` once). The camera needs
// a secure context — HTTPS makes it work on the LAN, not just localhost.
let https;
try {
  https = { key: fs.readFileSync('certs/key.pem'), cert: fs.readFileSync('certs/cert.pem') };
} catch {
  https = undefined;
}
const scheme = https ? 'https' : 'http';

const db = openDb(config.dbPath);
const iisLookup = createIisLookup({
  iisBaseUrl: config.iisBaseUrl,
  profileDir: process.env.CERVER_IIS_PROFILE || 'profile',
});
const verify = createVerifier({ db, iisLookup });
const app = buildApp({
  db,
  verify,
  keyProvider: keyProvider(),
  sealedDir: config.sealedDir,
  https,
});

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then(() => {
    console.log(`CerVer listening on ${scheme}://localhost:${config.port}`);
    if (!https) console.log('(HTTP only — run `npm run gen-cert` to enable HTTPS + camera on the LAN)');
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
