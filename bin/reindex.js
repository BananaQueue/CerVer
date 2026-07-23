import config from '../src/config.js';
import { openDb } from '../src/db.js';
import { reindex } from '../src/indexer.js';

const excel = process.argv[2] || config.excelPath;
const db = openDb(config.dbPath);
const res = await reindex(db, excel);
console.log(
  `Indexed ${res.total} rows from\n  ${excel}\n-> ${config.dbPath}\n  inserted=${res.inserted} updated=${res.updated}`
);
