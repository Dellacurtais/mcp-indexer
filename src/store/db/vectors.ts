import type { VectorIdRecord } from '@ctx/shared/types.js';
import type { DB } from './types.js';

export type VectorType = 'file' | 'symbol' | 'symbol_body' | 'snapshot';

export interface VectorIdInput {
  vectorId: string;
  filePath?: string;
  type: VectorType;
}

export function save(db: DB, projectId: number, vectors: VectorIdInput[]): void {
  // INSERT OR REPLACE — re-indexing the same file legitimately produces
  // the same vector_id (deterministic). REPLACE refreshes file_path/type
  // and stays idempotent for the common no-change case.
  const insert = db.prepare(`
    INSERT OR REPLACE INTO vector_ids (project_id, vector_id, file_path, type)
    VALUES (?, ?, ?, ?)
  `);

  const tx = db.transaction((items: VectorIdInput[]) => {
    for (const v of items) {
      insert.run(projectId, v.vectorId, v.filePath ?? null, v.type);
    }
  });

  tx(vectors);
}

export function listByProject(db: DB, projectId: number): VectorIdRecord[] {
  return db.prepare('SELECT * FROM vector_ids WHERE project_id = ?')
    .all(projectId) as VectorIdRecord[];
}

export function delByProject(db: DB, projectId: number): void {
  db.prepare('DELETE FROM vector_ids WHERE project_id = ?').run(projectId);
}

export function delByFile(db: DB, projectId: number, filePath: string): string[] {
  const records = db.prepare('SELECT vector_id FROM vector_ids WHERE project_id = ? AND file_path = ?')
    .all(projectId, filePath) as Array<{ vector_id: string }>;
  db.prepare('DELETE FROM vector_ids WHERE project_id = ? AND file_path = ?').run(projectId, filePath);
  return records.map(r => r.vector_id);
}

export function stats(db: DB, projectId: number): { total: number; byType: Record<string, number> } {
  const rows = db.prepare('SELECT type, COUNT(*) AS cnt FROM vector_ids WHERE project_id = ? GROUP BY type')
    .all(projectId) as Array<{ type: string; cnt: number }>;
  const byType: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byType[r.type] = r.cnt;
    total += r.cnt;
  }
  return { total, byType };
}

export function snapshotForProject(db: DB, projectId: number): string[] {
  return (
    db.prepare('SELECT vector_id FROM vector_ids WHERE project_id = ?')
      .all(projectId) as Array<{ vector_id: string }>
  ).map((r) => r.vector_id);
}

export function listOrphans(db: DB, projectId: number): Array<{ vector_id: string; file_path: string | null; type: string }> {
  return db.prepare(`
    SELECT v.vector_id, v.file_path, v.type
    FROM vector_ids v
    WHERE v.project_id = ?
      AND v.file_path IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM files f
        WHERE f.project_id = v.project_id AND f.path = v.file_path
      )
  `).all(projectId) as Array<{ vector_id: string; file_path: string | null; type: string }>;
}

// SQLite's default bind-parameter limit is 999; stay under it per statement.
const IN_CHUNK = 900;

export function deleteRows(db: DB, projectId: number, vectorIds: string[]): number {
  if (vectorIds.length === 0) return 0;
  const tx = db.transaction((ids: string[]) => {
    let n = 0;
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const slice = ids.slice(i, i + IN_CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      n += db.prepare(`DELETE FROM vector_ids WHERE project_id = ? AND vector_id IN (${placeholders})`)
        .run(projectId, ...slice).changes;
    }
    return n;
  });
  return tx(vectorIds);
}

export function dedup(db: DB, projectId?: number): number {
  const where = projectId != null ? 'WHERE project_id = ?' : '';
  const stmt = db.prepare(`
    DELETE FROM vector_ids
    WHERE id NOT IN (
      SELECT MAX(id) FROM vector_ids ${where}
      GROUP BY project_id, vector_id
    )
    ${where ? `AND project_id = ?` : ''}
  `);
  const result = projectId != null ? stmt.run(projectId, projectId) : stmt.run();
  return result.changes;
}

export function countPendingDeletes(db: DB): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM pending_vector_deletes').get() as { c: number };
  return row.c;
}

export interface PendingDeleteInput {
  vector_id: string;
  project_name?: string | null;
  error?: string | null;
}

export function enqueuePendingDeletes(db: DB, rows: PendingDeleteInput[]): number {
  if (rows.length === 0) return 0;
  const insert = db.prepare(`
    INSERT INTO pending_vector_deletes (vector_id, project_name, last_attempt, attempts, last_error)
    VALUES (?, ?, datetime('now'), 1, ?)
    ON CONFLICT(vector_id) DO UPDATE SET
      last_attempt = datetime('now'),
      attempts = attempts + 1,
      last_error = excluded.last_error
  `);
  const tx = db.transaction((rs: PendingDeleteInput[]) => {
    for (const r of rs) {
      insert.run(r.vector_id, r.project_name ?? null, r.error ?? null);
    }
    return rs.length;
  });
  return tx(rows);
}

export function takePendingDeletes(db: DB, limit = 5000): Array<{ id: number; vector_id: string; project_name: string | null }> {
  return db.prepare('SELECT id, vector_id, project_name FROM pending_vector_deletes ORDER BY id LIMIT ?')
    .all(limit) as Array<{ id: number; vector_id: string; project_name: string | null }>;
}

export function deletePendingByIds(db: DB, ids: number[]): number {
  if (ids.length === 0) return 0;
  const tx = db.transaction((items: number[]) => {
    let n = 0;
    for (let i = 0; i < items.length; i += IN_CHUNK) {
      const slice = items.slice(i, i + IN_CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      n += db.prepare(`DELETE FROM pending_vector_deletes WHERE id IN (${placeholders})`)
        .run(...slice).changes;
    }
    return n;
  });
  return tx(ids);
}
