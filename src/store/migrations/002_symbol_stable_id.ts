/**
 * Migration 002 — Symbol stable_id.
 *
 * Adds a `stable_id` column to `symbols` to enable deterministic symbol
 * identity across re-indexing. The id is derived from
 * `kind + name + parent + signature` (not `line`, which changes on every
 * edit), prefixed by the project id and file path for global uniqueness.
 *
 * Format:
 *   stable_id = sha1(`${projectId}:${filePath}:${kind}:${parent ?? ''}:${name}:${signature ?? ''}`)
 *
 * The hash is computed in JS at upsert time; this migration:
 *   1. Adds the `stable_id` TEXT column (nullable — old rows populated below).
 *   2. Backfills existing rows using the same formula as runtime.
 *   3. Creates an index on (project_id, stable_id) to speed lookups.
 *
 * Backfill happens in a loop to avoid loading huge sets at once.
 */
import { createHash } from 'node:crypto';
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

interface SymbolRow {
  id: number;
  project_id: number;
  file_path: string;
  name: string;
  kind: string;
  parent: string | null;
  signature: string;
}

/**
 * Compute a stable, deterministic id for a symbol. Exported so the runtime
 * upsert path can use the same formula — keep them in sync.
 */
export function computeStableId(input: {
  projectId: number;
  filePath: string;
  kind: string;
  parent: string | null | undefined;
  name: string;
  signature: string | null | undefined;
}): string {
  const parent = input.parent ?? '';
  const signature = input.signature ?? '';
  const material = `${input.projectId}:${input.filePath}:${input.kind}:${parent}:${input.name}:${signature}`;
  return createHash('sha1').update(material).digest('hex');
}

export const symbolStableId002: Migration = {
  version: 2,
  name: 'symbol_stable_id',
  up: (db: DB): void => {
    // 1. Add column if missing. SQLite doesn't support IF NOT EXISTS for
    //    ADD COLUMN, so probe pragma first.
    const cols = db.prepare("PRAGMA table_info(symbols)").all() as {
      name: string;
    }[];
    const hasStableId = cols.some((c) => c.name === 'stable_id');
    if (!hasStableId) {
      db.exec(`ALTER TABLE symbols ADD COLUMN stable_id TEXT`);
    }

    // 2. Backfill existing rows that don't have a stable_id yet.
    const rows = db
      .prepare(
        `SELECT id, project_id, file_path, name, kind, parent, signature
         FROM symbols WHERE stable_id IS NULL OR stable_id = ''`
      )
      .all() as SymbolRow[];

    if (rows.length > 0) {
      const update = db.prepare(
        'UPDATE symbols SET stable_id = ? WHERE id = ?'
      );
      const tx = db.transaction((batch: SymbolRow[]) => {
        for (const r of batch) {
          const sid = computeStableId({
            projectId: r.project_id,
            filePath: r.file_path,
            kind: r.kind,
            parent: r.parent,
            name: r.name,
            signature: r.signature,
          });
          update.run(sid, r.id);
        }
      });
      tx(rows);
    }

    // 3. Index on (project_id, stable_id) for fast lookups.
    //    Not UNIQUE: a failed upsert could briefly leave duplicates before
    //    cleanup, and a UNIQUE index would make recovery harder. Lookups
    //    still benefit.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_symbols_stable_id
       ON symbols(project_id, stable_id)`
    );
  },
};
