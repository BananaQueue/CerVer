import path from 'node:path';

const DEFAULT_EXCEL =
  "C:\\Users\\R1-MIS\\OneDrive - Environmental Management Bureau\\Lexter Galvez's files - IIS Transaction Logs\\IIS_Transactions_Log.xlsx";

const config = {
  excelPath: process.env.CERVER_EXCEL || DEFAULT_EXCEL,
  dbPath: process.env.CERVER_DB || path.resolve('cerver.db'),
  port: Number(process.env.PORT || 3000),
  httpsPort: Number(process.env.CERVER_HTTPS_PORT || 3443),
  iisBaseUrl: process.env.CERVER_IIS_BASE || 'https://iis.emb.gov.ph',
  sealedDir: process.env.CERVER_SEALED_DIR || path.resolve('sealed'),
  ocrLangPath: process.env.CERVER_OCR_LANGPATH || path.resolve('vendor', 'tesseract'),
  // Scratch dir for tesseract.js's own cache bookkeeping. Deliberately NOT
  // vendor/tesseract: on an Init() failure tesseract.js deletes
  // `${cachePath}/eng.traineddata`, and if cachePath pointed at the vendored
  // dir that would delete the working tree's only copy of the language data.
  ocrCachePath: process.env.CERVER_OCR_CACHEPATH || path.resolve('.cache', 'tesseract'),
};

export default config;
