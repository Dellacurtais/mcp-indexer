import type { ContextSnapshot, SnapshotCategory, SnapshotScope, SnapshotVersion } from '@ctx/shared/types.js';
import type { DB } from './types.js';
import { buildFtsMatch } from './fts-query.js';

export interface CreateSnapshotData {
  title: string;
  category: SnapshotCategory;
  content: string;
  tags?: string[];
  createdBy?: string;
  /** Memory provenance (migration 114). Defaults to 'manual'. */
  source?: string;
  /** 0..1 salience (migration 114). Defaults to 0.5. */
  importance?: number;
  /** Memory scope (migration 145). Defaults to 'project'. */
  scope?: SnapshotScope;
}

export type UpdateSnapshotData = Partial<Pick<ContextSnapshot, 'title' | 'category' | 'content'>> & {
  tags?: string[];
  updatedBy?: string;
  /** 0..1 retrieval salience (migration 114) — the Memory tab "pin" boost.
   *  Does NOT invalidate the embedding (content unchanged). */
  importance?: number;
};

export function create(db: DB, projectId: number, data: CreateSnapshotData): ContextSnapshot {
  // Invariant: user/feedback categories are always user-scope, even when the
  // generic distiller writer doesn't pass an explicit scope.
  const scope =
    data.scope ?? (data.category === 'user' || data.category === 'feedback' ? 'user' : 'project');
  const result = db.prepare(`
    INSERT INTO snapshots (project_id, title, category, content, tags, created_by, source, importance, scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, data.title, data.category, data.content,
    JSON.stringify(data.tags ?? []), data.createdBy ?? 'manual',
    data.source ?? 'manual', data.importance ?? 0.5, scope
  );
  return db.prepare('SELECT * FROM snapshots WHERE id = ?')
    .get(result.lastInsertRowid) as ContextSnapshot;
}

/** Bump usage signal when memory is retrieved (migration 114). Best-effort. */
export function markAccessed(db: DB, ids: number[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(
    `UPDATE snapshots SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?`,
  );
  const tx = db.transaction((list: number[]) => {
    for (const id of list) stmt.run(id);
  });
  tx(ids);
}

export function setFiles(db: DB, snapshotId: number, projectId: number, filePaths: string[]): { inserted: number; skipped: string[] } {
  let inserted = 0;
  const skipped: string[] = [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM snapshot_files WHERE snapshot_id = ?').run(snapshotId);
    if (filePaths.length === 0) return;
    const getHash = db.prepare('SELECT content_hash FROM files WHERE project_id = ? AND path = ?');
    const insert = db.prepare(
      'INSERT OR REPLACE INTO snapshot_files (snapshot_id, file_path, file_hash_at_creation) VALUES (?, ?, ?)'
    );
    for (const p of filePaths) {
      const row = getHash.get(projectId, p) as { content_hash: string } | undefined;
      if (row) {
        insert.run(snapshotId, p, row.content_hash);
        inserted++;
      } else {
        skipped.push(p);
      }
    }
  });
  tx();
  return { inserted, skipped };
}

export function getStaleFiles(db: DB, snapshotId: number, projectId: number): string[] {
  const rows = db.prepare(`
    SELECT sf.file_path, sf.file_hash_at_creation, f.content_hash
    FROM snapshot_files sf
    LEFT JOIN files f ON f.project_id = ? AND f.path = sf.file_path
    WHERE sf.snapshot_id = ?
  `).all(projectId, snapshotId) as {
    file_path: string;
    file_hash_at_creation: string;
    content_hash: string | null;
  }[];
  const stale: string[] = [];
  for (const r of rows) {
    if (r.content_hash === null || r.content_hash !== r.file_hash_at_creation) {
      stale.push(r.file_path);
    }
  }
  return stale;
}

/**
 * Batched staleness for many snapshots in ONE grouped query — avoids the N+1
 * of calling {@link getStaleFiles} per snapshot during retrieval ranking.
 * Returns snapshot_id → { stale: changed file paths, total: referenced files }.
 * Snapshots with no referenced files are absent from the map.
 */
export function getStaleFilesBatch(
  db: DB,
  snapshotIds: number[],
  projectId: number,
): Map<number, { stale: string[]; total: number }> {
  const out = new Map<number, { stale: string[]; total: number }>();
  if (snapshotIds.length === 0) return out;
  const placeholders = snapshotIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT sf.snapshot_id, sf.file_path, sf.file_hash_at_creation, f.content_hash
    FROM snapshot_files sf
    LEFT JOIN files f ON f.project_id = ? AND f.path = sf.file_path
    WHERE sf.snapshot_id IN (${placeholders})
  `).all(projectId, ...snapshotIds) as {
    snapshot_id: number;
    file_path: string;
    file_hash_at_creation: string;
    content_hash: string | null;
  }[];
  for (const r of rows) {
    let entry = out.get(r.snapshot_id);
    if (!entry) { entry = { stale: [], total: 0 }; out.set(r.snapshot_id, entry); }
    entry.total++;
    if (r.content_hash === null || r.content_hash !== r.file_hash_at_creation) {
      entry.stale.push(r.file_path);
    }
  }
  return out;
}

export function getFiles(db: DB, snapshotId: number): string[] {
  const rows = db.prepare(
    'SELECT file_path FROM snapshot_files WHERE snapshot_id = ? ORDER BY file_path'
  ).all(snapshotId) as { file_path: string }[];
  return rows.map((r) => r.file_path);
}

export function update(db: DB, id: number, updates: UpdateSnapshotData): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
  if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category); }
  if (updates.content !== undefined) { fields.push('content = ?'); values.push(updates.content); }
  if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }
  if (updates.importance !== undefined) {
    fields.push('importance = ?');
    values.push(Math.max(0, Math.min(1, updates.importance)));
  }

  if (fields.length === 0) return;

  // Importance-only updates (the Memory tab pin) are metadata: no version
  // row, no FTS churn, no embedding invalidation — just the column.
  const contentChanged =
    updates.title !== undefined ||
    updates.category !== undefined ||
    updates.content !== undefined ||
    updates.tags !== undefined;
  if (!contentChanged) {
    values.push(id);
    db.prepare(`UPDATE snapshots SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return;
  }

  fields.push("updated_at = datetime('now')");
  if (updates.title !== undefined || updates.content !== undefined) {
    fields.push('embedding_hash = NULL');
  }
  values.push(id);

  const updatedBy = updates.updatedBy ?? 'manual';

  const tx = db.transaction(() => {
    const current = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as ContextSnapshot | undefined;
    if (current) {
      const maxVersion = db.prepare(
        'SELECT COALESCE(MAX(version), 0) as v FROM snapshot_versions WHERE snapshot_id = ?'
      ).get(id) as { v: number };

      db.prepare(`
        INSERT INTO snapshot_versions (snapshot_id, version, title, category, content, tags, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, maxVersion.v + 1, current.title, current.category, current.content, current.tags, current.updated_at, updatedBy);

      db.prepare(
        "INSERT INTO snapshots_fts(snapshots_fts, rowid, title, content, tags) VALUES ('delete', ?, ?, ?, ?)"
      ).run(current.id, current.title, current.content, current.tags);
    }

    db.prepare(`UPDATE snapshots SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as ContextSnapshot | undefined;
    if (updated) {
      db.prepare(
        'INSERT INTO snapshots_fts(rowid, title, content, tags) VALUES (?, ?, ?, ?)'
      ).run(updated.id, updated.title, updated.content, updated.tags);
    }
  });

  tx();
}

export function updateEmbeddingHash(db: DB, id: number, hash: string): void {
  db.prepare('UPDATE snapshots SET embedding_hash = ? WHERE id = ?').run(hash, id);
}

export function listMissingEmbedding(db: DB, projectId?: number): ContextSnapshot[] {
  // Archived rows are excluded — their vectors were dropped on archive and we
  // don't want backfill re-embedding them. Un-archive NULLs the hash again so
  // a restored row is picked back up here.
  if (projectId === undefined) {
    return db.prepare('SELECT * FROM snapshots WHERE embedding_hash IS NULL AND archived_at IS NULL ORDER BY id').all() as ContextSnapshot[];
  }
  return db.prepare('SELECT * FROM snapshots WHERE project_id = ? AND embedding_hash IS NULL AND archived_at IS NULL ORDER BY id')
    .all(projectId) as ContextSnapshot[];
}

export interface MemoryIndexEntry {
  id: number;
  title: string;
  category: string;
  importance: number;
  /** First ~200 chars of the body — fed to the task-preflight analyzer. */
  excerpt?: string;
}

/**
 * MEMORY.md-style index — top-N one-liners (title + category) ranked by
 * importance × 30-day recency decay, injected at session start so every
 * session knows WHAT the project has learned (full bodies via recall).
 * Does NOT mark access — reading a title is not using the memory.
 */
export function listMemoryIndex(db: DB, projectId: number, limit = 12): MemoryIndexEntry[] {
  const rows = db.prepare(`
    SELECT id, title, category, importance, last_accessed_at, created_at,
           substr(content, 1, 200) AS excerpt
    FROM snapshots WHERE project_id = ? AND archived_at IS NULL
    ORDER BY importance DESC LIMIT 100
  `).all(projectId) as Array<{
    id: number; title: string; category: string; importance: number;
    last_accessed_at: string | null; created_at: string; excerpt: string | null;
  }>;
  const now = Date.now();
  const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // same half-life as the retriever
  const scored = rows.map((r) => {
    const ts = Date.parse(`${(r.last_accessed_at ?? r.created_at).replace(' ', 'T')}Z`);
    const age = Number.isNaN(ts) ? HALF_LIFE_MS : Math.max(0, now - ts);
    return { r, score: (r.importance ?? 0.5) * Math.pow(0.5, age / HALF_LIFE_MS) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit)).map(({ r }) => ({
    id: r.id, title: r.title, category: r.category, importance: r.importance ?? 0.5,
    excerpt: r.excerpt ?? undefined,
  }));
}

export function count(db: DB, projectId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM snapshots WHERE project_id = ? AND archived_at IS NULL')
    .get(projectId) as { c: number };
  return row.c;
}

export function countVectors(db: DB, projectId: number): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM vector_ids WHERE project_id = ? AND type = 'snapshot'")
    .get(projectId) as { c: number };
  return row.c;
}

export function del(db: DB, id: number): void {
  db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
}

export function getById(db: DB, id: number): ContextSnapshot | undefined {
  return db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as ContextSnapshot | undefined;
}

export function list(db: DB, projectId: number, category?: SnapshotCategory): ContextSnapshot[] {
  if (category) {
    return db.prepare('SELECT * FROM snapshots WHERE project_id = ? AND category = ? AND archived_at IS NULL ORDER BY created_at DESC')
      .all(projectId, category) as ContextSnapshot[];
  }
  return db.prepare('SELECT * FROM snapshots WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at DESC')
    .all(projectId) as ContextSnapshot[];
}

export function search(db: DB, projectId: number, query: string): ContextSnapshot[] {
  const ftsQuery = buildFtsMatch(query, 'OR');
  if (!ftsQuery) return [];
  try {
    return db.prepare(`
      SELECT s.* FROM snapshots_fts fts
      JOIN snapshots s ON s.id = fts.rowid
      WHERE fts.snapshots_fts MATCH ? AND s.project_id = ? AND s.archived_at IS NULL
      ORDER BY rank
    `).all(ftsQuery, projectId) as ContextSnapshot[];
  } catch {
    const pattern = `%${query}%`;
    return db.prepare(
      'SELECT * FROM snapshots WHERE project_id = ? AND archived_at IS NULL AND (title LIKE ? OR content LIKE ?) ORDER BY created_at DESC'
    ).all(projectId, pattern, pattern) as ContextSnapshot[];
  }
}

export function getHistory(db: DB, snapshotId: number): SnapshotVersion[] {
  return db.prepare('SELECT * FROM snapshot_versions WHERE snapshot_id = ? ORDER BY version DESC')
    .all(snapshotId) as SnapshotVersion[];
}
