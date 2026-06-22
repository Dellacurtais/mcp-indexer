/**
 * Recreate the project tables that carry a cross-DB FOREIGN KEY (to a CENTRAL
 * table being dropped) WITHOUT that FK, preserving columns + data + intra-DB FKs
 * + CHECKs + indexes (C2 trim). Auto-discovers the affected tables (any KEEP
 * table whose CREATE SQL references a central table) so a missed edge can't slip.
 *
 * Technique: read the verbatim CREATE from sqlite_master, strip ONLY the
 * `REFERENCES <central>(…)` clauses (inline + standalone FOREIGN KEY), recreate
 * as `<t>__trim`, copy rows, drop, rename, recreate indexes. The caller MUST run
 * this with foreign_keys=OFF (outside any transaction) — see trim/index.ts.
 */
import type { DB } from '../../db/types.js';
import { CENTRAL_DROP_TABLES, projectKeepTables } from './drop-list.js';

/** Remove every `REFERENCES <central>(…) [ON DELETE/UPDATE …]` (inline + standalone). */
export function stripCentralFks(createSql: string, centralTables: string[]): string {
  let sql = createSql;
  const action = '(\\s+ON\\s+(DELETE|UPDATE)\\s+(NO\\s+ACTION|RESTRICT|SET\\s+NULL|SET\\s+DEFAULT|CASCADE))*';
  for (const c of centralTables) {
    const ref = `REFERENCES\\s+"?${c}"?\\s*\\([^)]*\\)${action}`;
    // standalone: optional leading comma + FOREIGN KEY(cols) REFERENCES central(…)
    sql = sql.replace(new RegExp(`,?\\s*FOREIGN\\s+KEY\\s*\\([^)]*\\)\\s+${ref}`, 'gi'), '');
    // inline column-level reference
    sql = sql.replace(new RegExp(`\\s*${ref}`, 'gi'), '');
  }
  // tidy a dangling comma left by a removed trailing standalone clause: ", )" -> ")"
  return sql.replace(/,(\s*\))/g, '$1');
}

function referencesCentral(sql: string): string[] {
  return CENTRAL_DROP_TABLES.filter((c) => new RegExp(`REFERENCES\\s+"?${c}"?\\b`, 'i').test(sql));
}

function recreateOne(db: DB, table: string, origSql: string, refs: string[]): void {
  const cols = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[])
    .map((c) => `"${c.name}"`).join(', ');
  const indexes = (db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`,
  ).all(table) as { sql: string }[]).map((r) => r.sql);

  const tmp = `${table}__trim`;
  db.exec(`DROP TABLE IF EXISTS "${tmp}"`); // discard a partial tmp from a prior crash
  const stripped = stripCentralFks(origSql, refs)
    .replace(new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?"?${table}"?`, 'i'), `CREATE TABLE "${tmp}"`);
  if (new RegExp(`REFERENCES\\s+"?(${refs.join('|')})"?\\b`, 'i').test(stripped)) {
    throw new Error(`[project-db/trim] failed to strip central FK from ${table}`);
  }
  db.exec(stripped);
  db.exec(`INSERT INTO "${tmp}" (${cols}) SELECT ${cols} FROM "${table}"`);
  db.exec(`DROP TABLE "${table}"`);
  db.exec(`ALTER TABLE "${tmp}" RENAME TO "${table}"`);
  for (const idxSql of indexes) {
    try { db.exec(idxSql); } catch { /* duplicate/auto index — skip */ }
  }
}

/**
 * Recreate every project (KEEP) table that references a central table, stripping
 * the cross-DB FK. Returns the names recreated. Idempotent: a table with no
 * central reference (already trimmed) is skipped.
 */
export function recreateFkEdgeTables(db: DB): string[] {
  const keep = projectKeepTables();
  const recreated: string[] = [];
  const tables = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL`,
  ).all() as { name: string; sql: string }[];
  for (const { name, sql } of tables) {
    if (name === 'projects' || !keep.has(name)) continue; // central tables handled by the drop pass
    const refs = referencesCentral(sql);
    if (refs.length === 0) continue;
    recreateOne(db, name, sql, refs);
    recreated.push(name);
  }
  return recreated;
}
