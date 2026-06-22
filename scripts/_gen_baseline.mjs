// Generate a single clean baseline DDL from the dumped production schema,
// keeping only retrieval + provider + infra tables and dropping IDE-specific
// ones (anonymization). FTS shadow tables are excluded (the CREATE VIRTUAL
// TABLE statement recreates them). All CREATEs get IF NOT EXISTS for idempotency.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const objects = JSON.parse(
  fs.readFileSync(path.join(os.tmpdir(), 'ctx-schema', 'schema-objects.json'), 'utf8'),
);

// Drop any table whose name starts with one of these IDE-feature prefixes.
const DROP_PREFIX = [
  'agent_', 'api_', 'auth_', 'chrome_', 'coder_', 'company_', 'design_system_',
  'doc_', 'docs_', 'embedding_lsh', 'embedding_simhash', 'installed_plugins',
  'kanban_', 'mcp_oauth', 'mcp_server', 'oauth_auth_codes', 'oauth_clients',
  'oauth_refresh', 'pipeline', 'plugin_', 'qa_', 'quality_', 'session_',
  'skill_', 'sub_agent_', 'training_', 'verdaccio_', 'builder_checkpoints',
  'counterfactual_', 'project_doc_collections', 'project_runtime_config',
];
const DROP_EXACT = new Set(['disabled_tools_global', 'memory_distill_log']);
// FTS5 shadow tables — recreated by the parent CREATE VIRTUAL TABLE.
const isFtsShadow = (n) => /_fts_(data|idx|config|docsize|content)$/.test(n);

const keepTable = (n) => {
  if (n === 'sqlite_sequence') return false; // managed by sqlite
  if (isFtsShadow(n)) return false;
  if (DROP_EXACT.has(n)) return false;
  if (DROP_PREFIX.some((p) => n.startsWith(p))) return false;
  return true;
};

const keptTableNames = new Set(
  objects.filter((o) => o.type === 'table' && keepTable(o.name)).map((o) => o.name),
);

// Keep an index/trigger only if its target table is kept.
const keep = (o) => {
  if (o.type === 'table') return keepTable(o.name);
  return keptTableNames.has(o.tbl_name);
};

const idempotent = (sql) =>
  sql
    .replace(/^CREATE\s+TABLE\s+(?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ')
    .replace(/^CREATE\s+VIRTUAL\s+TABLE\s+(?!IF NOT EXISTS)/i, 'CREATE VIRTUAL TABLE IF NOT EXISTS ')
    .replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/i, (m, u) => `CREATE ${u || ''}INDEX IF NOT EXISTS `)
    .replace(/^CREATE\s+TRIGGER\s+(?!IF NOT EXISTS)/i, 'CREATE TRIGGER IF NOT EXISTS ');

const order = { table: 0, index: 1, trigger: 2 };
const kept = objects.filter(keep).sort(
  (a, b) => (order[a.type] - order[b.type]) || a.tbl_name.localeCompare(b.tbl_name),
);

const ddl = kept.map((o) => idempotent(o.sql.trim()) + ';').join('\n\n');

const droppedTables = objects
  .filter((o) => o.type === 'table' && !keepTable(o.name) && !isFtsShadow(o.name) && o.name !== 'sqlite_sequence')
  .map((o) => o.name);

console.log('KEPT tables (' + keptTableNames.size + '):');
console.log([...keptTableNames].sort().join('\n'));
console.log('\nDROPPED tables (' + droppedTables.length + '): ' + droppedTables.sort().join(', '));
console.log('\nKEPT objects: ' + kept.length + ' (tables ' + kept.filter((o) => o.type === 'table').length +
  ', indexes ' + kept.filter((o) => o.type === 'index').length +
  ', triggers ' + kept.filter((o) => o.type === 'trigger').length + ')');

const ts =
  '// AUTO-GENERATED baseline schema for the code-context server.\n' +
  '// Derived from a fully-migrated index.db, pruned to retrieval + provider + infra\n' +
  '// tables (IDE-specific tables dropped). Regenerate via scripts/_gen_baseline.mjs.\n' +
  '/* eslint-disable */\n' +
  'export const BASELINE_DDL = String.raw`\n' +
  ddl.replace(/`/g, '\\`') +
  '\n`;\n';

const out = path.join(process.cwd(), 'src', 'store', 'db', 'schema', 'baseline.ts');
fs.writeFileSync(out, ts);
console.log('\nWROTE ' + out + ' (' + ddl.length + ' chars)');
