/**
 * Copy a project's rows out of the legacy central DB into its own project DB
 * (tiered-hybrid split, plan §8.5).
 *
 * The new project DB already has the full schema (project-schema.ts), so the
 * copy is a straight `INSERT INTO main.t SELECT <cols> FROM legacy.t WHERE
 * project_id=?` per manifest table, with explicit columns so `id` is preserved.
 *
 * Runs with `foreign_keys=OFF` during the bulk load: the project DB's
 * `projects` table starts empty, so the `project_id REFERENCES projects(id)`
 * constraint would otherwise reject every row. We first copy the project's own
 * `projects` row (so the FK is satisfiable), then re-enable + check FKs in the
 * verify step. The external-content FTS (files_fts/symbols_fts) auto-populate
 * via their AFTER INSERT triggers as rows land; contentless file_contents_fts
 * stays empty and self-heals on the next structural sweep.
 */
import type { DB } from '../db/types.js';
import { manifestFor, entryWhere, type SplitClass } from './manifest.js';

const LEGACY = 'legacy';

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

function columnsOf(db: DB, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

export interface CopyResult {
  /** Rows copied per table (only tables that existed in both DBs). */
  perTable: Record<string, number>;
  total: number;
}

/**
 * Copy `projectId`'s data from the ATTACHed legacy central DB into `proj`.
 * `proj` MUST be a freshly-created (empty) project DB. Idempotent only on a
 * fresh file — the caller (state machine) deletes + recreates before retrying.
 */
export function copyProjectData(
  proj: DB,
  legacyCentralPath: string,
  projectId: number,
  classes: SplitClass[] = ['INDEX'],
): CopyResult {
  const perTable: Record<string, number> = {};
  let total = 0;

  proj.pragma('foreign_keys = OFF');
  proj.exec(`ATTACH DATABASE '${legacyCentralPath.replace(/'/g, "''")}' AS ${LEGACY}`);
  try {
    const run = proj.transaction(() => {
      // 1) The project's own catalog row — satisfies the project_id FK and makes
      //    the project DB self-describing. (projects stays central authoritatively.)
      copyProjectsRow(proj, projectId);

      // 2) Manifest tables, in dependency order. `proj` has every table by
      //    construction (full schema); a legacy central from an older build may
      //    be missing one — skip those tolerantly.
      for (const entry of manifestFor(classes)) {
        if (!tableExists(proj, entry.table) || !legacyHasTable(proj, entry.table)) continue;
        const cols = columnsOf(proj, entry.table).filter((c) =>
          legacyColumns(proj, entry.table).includes(c),
        );
        if (cols.length === 0) continue;
        const list = cols.map((c) => `"${c}"`).join(', ');
        const info = proj.prepare(
          `INSERT INTO "${entry.table}" (${list})
             SELECT ${list} FROM ${LEGACY}."${entry.table}" WHERE ${entryWhere(entry)}`,
        ).run({ pid: projectId });
        perTable[entry.table] = info.changes;
        total += info.changes;
      }

      reconcileSequences(proj);
    });
    run();
  } finally {
    proj.exec(`DETACH DATABASE ${LEGACY}`);
    proj.pragma('foreign_keys = ON');
  }
  return { perTable, total };
}

function copyProjectsRow(proj: DB, projectId: number): void {
  const cols = columnsOf(proj, 'projects').filter((c) => legacyColumns(proj, 'projects').includes(c));
  const list = cols.map((c) => `"${c}"`).join(', ');
  proj.prepare(
    `INSERT OR REPLACE INTO projects (${list})
       SELECT ${list} FROM ${LEGACY}.projects WHERE id = @pid`,
  ).run({ pid: projectId });
}

function legacyHasTable(proj: DB, table: string): boolean {
  return !!proj.prepare(`SELECT 1 FROM ${LEGACY}.sqlite_master WHERE type='table' AND name=?`).get(table);
}

function legacyColumns(proj: DB, table: string): string[] {
  return (proj.prepare(`PRAGMA ${LEGACY}.table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
}

/** Set sqlite_sequence to MAX(id) per copied table so future inserts don't collide. */
function reconcileSequences(proj: DB): void {
  if (!tableExists(proj, 'sqlite_sequence')) return;
  const tables = (proj.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN
       (SELECT name FROM sqlite_sequence)`,
  ).all() as { name: string }[]).map((r) => r.name);
  for (const t of tables) {
    try {
      const row = proj.prepare(`SELECT MAX(id) AS m FROM "${t}"`).get() as { m: number | null };
      if (row.m != null) {
        proj.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = ?`).run(row.m, t);
      }
    } catch {
      /* table has no INTEGER PRIMARY KEY AUTOINCREMENT — skip */
    }
  }
}
