import fs from 'node:fs';
import config from './config.js';
import { openDb } from './db.js';
import { createVerifier } from './verifyService.js';
import { createIisLookup } from './iisLookup.js';
import { keyProvider } from './sealKeys.js';
import { buildApp } from './app.js';

// Read the self-signed cert if present (run `npm run gen-cert` once).
let tls;
try {
  tls = { key: fs.readFileSync('certs/key.pem'), cert: fs.readFileSync('certs/cert.pem') };
} catch {
  tls = undefined;
}

const db = openDb(config.dbPath);
const iisLookup = createIisLookup({
  iisBaseUrl: config.iisBaseUrl,
  profileDir: process.env.CERVER_IIS_PROFILE || 'profile',
});
const verify = createVerifier({ db, iisLookup });

const buildOne = (https) =>
  buildApp({ db, verify, keyProvider: keyProvider(), sealedDir: config.sealedDir, https });

// HTTP on localhost (camera works on localhost even over http), and — when a cert
// exists — HTTPS too, so the camera also works over the LAN (phones).
try {
  await buildOne(undefined).listen({ port: config.port, host: '0.0.0.0' });
  console.log(`CerVer (HTTP)  http://localhost:${config.port}`);
  if (tls) {
    await buildOne(tls).listen({ port: config.httpsPort, host: '0.0.0.0' });
    console.log(`CerVer (HTTPS) https://localhost:${config.httpsPort}  — use this on the LAN/phone for the camera`);
  } else {
    console.log('(no cert — run `npm run gen-cert` to enable HTTPS + camera on the LAN)');
  }
} catch (e) {
  console.error(e);
  process.exit(1);
}
