import config from './config.js';
import { openDb } from './db.js';
import { createVerifier } from './verifyService.js';
import { createIisLookup } from './iisLookup.js';
import { keyProvider } from './sealKeys.js';
import { buildApp } from './app.js';

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
});

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then(() => console.log(`CerVer listening on http://localhost:${config.port}`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
