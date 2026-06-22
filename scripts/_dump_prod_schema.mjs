import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const src = process.env.SRC_DB || path.join(os.homedir(), '.mcp-code-indexer', 'index.db');
const db = new Database(src, { readonly: true, fileMustExist: true });
const rows = db
  .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL")
  .all();

const order = { table: 0, index: 1, trigger: 2, view: 3 };
rows.sort((a, b) => (order[a.type] - order[b.type]) || a.tbl_name.localeCompare(b.tbl_name) || a.name.localeCompare(b.name));

const tables = rows.filter((r) => r.type === 'table').map((r) => r.name);
console.log('SRC', src);
console.log('TOTAL', rows.length, '| tables', tables.length,
  '| indexes', rows.filter((r) => r.type === 'index').length,
  '| triggers', rows.filter((r) => r.type === 'trigger').length,
  '| views', rows.filter((r) => r.type === 'view').length);
console.log('\n=== ALL TABLES ===\n' + tables.join('\n'));

const outDir = path.join(os.tmpdir(), 'ctx-schema');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'schema-full.sql'), rows.map((r) => r.sql.trim() + ';').join('\n\n'));
fs.writeFileSync(path.join(outDir, 'schema-objects.json'), JSON.stringify(rows, null, 2));
console.log('\nWROTE ' + outDir + '/schema-full.sql  (' + outDir + '/schema-objects.json)');
db.close();
