import type { ContextSnapshot } from '@ctx/shared/types.js';
import type { DB } from './types.js';

/**
 * Archive / merge helpers for the memory consolidator (migration 146).
 *
 * Kept in a sibling module so the legacy `snapshots.ts` god-file doesn't grow.
 * Archiving is a reversible soft-delete: the row stays (with its versions,
 * files and FK chain) so it can be restored; only the agent-facing read paths
 * filter it out via `archived_at IS NULL`.
 */

/** Soft-delete a snapshot. `reason` is "merged:<winnerId>" or a GC reason. */
export function archive(db: DB, id: number, reason: string): void {
  db.prepare(
    "UPDATE snapshots SET archived_at = datetime('now'), archived_reason = ? WHERE id = ?",
  ).run(reason, id);
}

/**
 * Restore an archived snapshot. Clears the embedding hash so the backfill
 * re-embeds it (its vectors were dropped on archive).
 */
export function unarchive(db: DB, id: number): void {
  db.prepare(
    'UPDATE snapshots SET archived_at = NULL, archived_reason = NULL, embedding_hash = NULL WHERE id = ?',
  ).run(id);
}

/**
 * Union the file references of `loserIds` into `winnerId`, preserving each
 * row's ORIGINAL `file_hash_at_creation` so the winner's staleness baseline
 * stays honest. (Do NOT use `setFiles` here — it re-hashes against current
 * content and would silently reset every baseline.)
 */
export function unionFiles(db: DB, winnerId: number, loserIds: number[]): void {
  if (loserIds.length === 0) return;
  const placeholders = loserIds.map(() => '?').join(', ');
  db.prepare(`
    INSERT OR IGNORE INTO snapshot_files (snapshot_id, file_path, file_hash_at_creation)
    SELECT ?, file_path, file_hash_at_creation
    FROM snapshot_files
    WHERE snapshot_id IN (${placeholders})
  `).run(winnerId, ...loserIds);
}

/** Overwrite usage stats on the merge winner (sum of access, latest touch). */
export function setAccessStats(
  db: DB,
  id: number,
  accessCount: number,
  lastAccessedAt: string | null,
): void {
  db.prepare('UPDATE snapshots SET access_count = ?, last_accessed_at = ? WHERE id = ?')
    .run(accessCount, lastAccessedAt, id);
}

/** Count archived rows for a project (the Memory health "archived N" chip). */
export function countArchived(db: DB, projectId: number): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM snapshots WHERE project_id = ? AND archived_at IS NOT NULL',
  ).get(projectId) as { c: number };
  return row.c;
}

/** List archived rows (most-recent first) for the restore surface. */
export function listArchived(db: DB, projectId: number, limit = 50): ContextSnapshot[] {
  return db.prepare(
    'SELECT * FROM snapshots WHERE project_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC LIMIT ?',
  ).all(projectId, Math.max(1, limit)) as ContextSnapshot[];
}
