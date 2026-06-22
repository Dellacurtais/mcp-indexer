/**
 * C3 — reclaim central space by deleting a migrated project's INDEX rows from
 * the CENTRAL DB, AFTER its split is verified + soaked (served from its own DB
 * across ≥1 restart).
 *
 * SCOPED to the INDEX class ONLY: those reads are routed to the project DB (P2b)
 * so deleting them centrally is safe, and they are the bulk of the 1.7 GB file.
 * FEATURE-class purging is deferred until every feature store routes to the
 * project DB (R1 follow-up) — purging an un-routed feature's central rows would
 * lose data the app still reads from central. costs/runs are central by design
 * (never copied) and are NOT in this list.
 *
 * Deletes in REVERSE manifest order (children before parents) with FKs on; the
 * external-content FTS (files_fts/symbols_fts) + contentless file_contents_fts
 * self-clean via their AFTER DELETE triggers as the base rows go.
 *
 * DESTRUCTIVE on the central (the durable copy). The caller guards it: only when
 * purgeMode='immediate' (default 'defer'), the project is 'done', not already
 * purged, and split in a PRIOR session (soak). The one-time `.bak` (backup.ts)
 * is the rollback.
 */
import type { DB } from '../db/types.js';
import { INDEX_TABLES } from './manifest.js';

export interface PurgeResult {
  purged: number;
  perTable: Record<string, number>;
}

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

/** Delete a project's INDEX rows from the central DB (reverse order, one tx). */
export function purgeProjectIndex(central: DB, projectId: number): PurgeResult {
  const perTable: Record<string, number> = {};
  let purged = 0;
  const tables = [...INDEX_TABLES].reverse(); // children before parents (FK-safe)
  const run = central.transaction(() => {
    for (const entry of tables) {
      if (!tableExists(central, entry.table)) continue;
      const info = central.prepare(`DELETE FROM "${entry.table}" WHERE project_id = ?`).run(projectId);
      if (info.changes) {
        perTable[entry.table] = info.changes;
        purged += info.changes;
      }
    }
  });
  run();
  return { perTable, purged };
}

/**
 * Reclaim the purged pages to the OS. SQLite reuses freed pages but does NOT
 * shrink the file without a VACUUM. This is a FULL vacuum — it rewrites the
 * whole DB and takes an exclusive lock, so it is heavy on a large central file
 * and must be an EXPLICIT, opt-in maintenance step (never auto-run after a
 * purge, which would freeze the app). Returns bytes reclaimed (best-effort).
 */
export function vacuumCentral(central: DB): number {
  const pageSize = central.pragma('page_size', { simple: true }) as number;
  const before = central.pragma('page_count', { simple: true }) as number;
  central.exec('VACUUM');
  const after = central.pragma('page_count', { simple: true }) as number;
  return Math.max(0, (before - after) * (pageSize || 4096));
}
