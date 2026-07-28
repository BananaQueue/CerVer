import path from 'node:path';

const DEFAULT_EXCEL =
  "C:\\Users\\R1-MIS\\OneDrive - Environmental Management Bureau\\Lexter Galvez's files - IIS Transaction Logs\\IIS_Transactions_Log.xlsx";

const config = {
  excelPath: process.env.CERVER_EXCEL || DEFAULT_EXCEL,
  dbPath: process.env.CERVER_DB || path.resolve('cerver.db'),
  port: Number(process.env.PORT || 3100),
  httpsPort: Number(process.env.CERVER_HTTPS_PORT || 3443),
  iisBaseUrl: process.env.CERVER_IIS_BASE || 'https://iis.emb.gov.ph',
  sealedDir: process.env.CERVER_SEALED_DIR || path.resolve('sealed'),
};

export default config;
