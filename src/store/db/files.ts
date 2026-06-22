import type { DBFile, FileSnapshot, LLMSymbol } from '@ctx/shared/types.js';
import type { DB } from './types.js';

export interface UpsertFileData {
  path: string;
  language: string;
  size: number;
  lineCount: number;
  contentHash: string;
  summary: string;
  concepts: string[];
  dependencies: string[];
  internalDeps: string[];
  externalDeps: string[];
  notes: string[];
  complexity: string;
  layer?: string;
  isEntryPoint?: boolean;
  isTest?: boolean;
  isGenerated?: boolean;
  /** Mapper tier persisted by migration 071. Optional for backwards compat. */
  indexTier?: 'core' | 'support' | 'on_demand';
  mapperReason?: string;
  /**
   * fs.stat mtime in ms (migration 137) — drives the stat-first scanner.
   * Omitted/null keeps the stored value (COALESCE) so callers without a
   * fresh stat (force re-scan) don't regress it to NULL.
   */
  mtimeMs?: number | null;
}

export function upsert(db: DB, projectId: number, data: UpsertFileData): number {
  const tx = db.transaction(() => {
    const existing = db.prepare(
      'SELECT id, path, summary, concepts FROM files WHERE project_id = ? AND path = ?'
    ).get(projectId, data.path) as { id: number; path: string; summary: string; concepts: string } | undefined;

    let fileId: number;

    if (existing) {
      fileId = existing.id;
      db.prepare(
        "INSERT INTO files_fts(files_fts, rowid, path, summary, concepts) VALUES ('delete', ?, ?, ?, ?)"
      ).run(existing.id, existing.path, existing.summary, existing.concepts);

      db.prepare(`
        UPDATE files SET
          language = ?, size = ?, line_count = ?, content_hash = ?,
          summary = ?, concepts = ?, dependencies = ?,
          internal_deps = ?, external_deps = ?,
          notes = ?, complexity = ?,
          layer = ?, is_entry_point = ?, is_test = ?, is_generated = ?,
          index_tier = COALESCE(?, index_tier),
          mapper_reason = COALESCE(?, mapper_reason),
          mtime_ms = COALESCE(?, mtime_ms),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        data.language, data.size, data.lineCount, data.contentHash,
        data.summary, JSON.stringify(data.concepts), JSON.stringify(data.dependencies),
        JSON.stringify(data.internalDeps), JSON.stringify(data.externalDeps),
        JSON.stringify(data.notes), data.complexity,
        data.layer ?? 'unknown', data.isEntryPoint ? 1 : 0, data.isTest ? 1 : 0, data.isGenerated ? 1 : 0,
        data.indexTier ?? null, data.mapperReason ?? null,
        data.mtimeMs ?? null,
        existing.id
      );

      db.prepare(
        'INSERT INTO files_fts(rowid, path, summary, concepts) VALUES (?, ?, ?, ?)'
      ).run(existing.id, data.path, data.summary, JSON.stringify(data.concepts));
    } else {
      const result = db.prepare(`
        INSERT INTO files (project_id, path, language, size, line_count, content_hash,
          summary, concepts, dependencies, internal_deps, external_deps, notes, complexity,
          layer, is_entry_point, is_test, is_generated, index_tier, mapper_reason, mtime_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId, data.path, data.language, data.size, data.lineCount, data.contentHash,
        data.summary, JSON.stringify(data.concepts), JSON.stringify(data.dependencies),
        JSON.stringify(data.internalDeps), JSON.stringify(data.externalDeps),
        JSON.stringify(data.notes), data.complexity,
        data.layer ?? 'unknown', data.isEntryPoint ? 1 : 0, data.isTest ? 1 : 0, data.isGenerated ? 1 : 0,
        data.indexTier ?? null, data.mapperReason ?? null, data.mtimeMs ?? null
      );
      fileId = result.lastInsertRowid as number;
    }

    db.prepare('DELETE FROM file_concepts WHERE file_id = ?').run(fileId);
    const insertConcept = db.prepare(
      'INSERT INTO file_concepts (project_id, file_id, concept) VALUES (?, ?, ?)'
    );
    for (const concept of data.concepts) {
      insertConcept.run(projectId, fileId, concept);
    }

    return fileId;
  });

  return tx();
}

export function get(db: DB, projectId: number, path: string): DBFile | undefined {
  return db.prepare('SELECT * FROM files WHERE project_id = ? AND path = ?')
    .get(projectId, path) as DBFile | undefined;
}

export function getById(db: DB, id: number): DBFile | undefined {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as DBFile | undefined;
}

export function list(db: DB, projectId: number, language?: string): DBFile[] {
  if (language) {
    return db.prepare('SELECT * FROM files WHERE project_id = ? AND language = ? ORDER BY path')
      .all(projectId, language) as DBFile[];
  }
  return db.prepare('SELECT * FROM files WHERE project_id = ? ORDER BY path')
    .all(projectId) as DBFile[];
}

export interface FileScanMeta {
  path: string;
  content_hash: string;
  mtime_ms: number | null;
  size: number;
}

/**
 * Slim per-file metadata for the stat-first scanner — 4 columns instead of
 * the full row (the old scan dragged summary/concepts/notes of EVERY file
 * into memory on every scan just to read content_hash).
 */
export function listScanMeta(db: DB, projectId: number): FileScanMeta[] {
  return db.prepare(
    'SELECT path, content_hash, mtime_ms, size FROM files WHERE project_id = ?'
  ).all(projectId) as FileScanMeta[];
}

/**
 * Stamp a fresh mtime on an unchanged file (hash matched after a read) so
 * the NEXT scan takes the stat-only shortcut. Also the automatic backfill
 * path for rows created before migration 137.
 */
export function touchMtime(db: DB, projectId: number, path: string, mtimeMs: number): void {
  db.prepare('UPDATE files SET mtime_ms = ? WHERE project_id = ? AND path = ?')
    .run(mtimeMs, projectId, path);
}

export function del(db: DB, projectId: number, path: string): void {
  db.prepare('DELETE FROM files WHERE project_id = ? AND path = ?').run(projectId, path);
}

export function delByProject(db: DB, projectId: number): void {
  db.prepare('DELETE FROM files WHERE project_id = ?').run(projectId);
}

export function search(db: DB, projectId: number, query: string, limit: number = 20): DBFile[] {
  return db.prepare(`
    SELECT f.* FROM files_fts fts
    JOIN files f ON f.id = fts.rowid
    WHERE fts.files_fts MATCH ? AND f.project_id = ?
    ORDER BY rank
    LIMIT ?
  `).all(query, projectId, limit) as DBFile[];
}

export interface FileSnapshotData {
  runId: number;
  projectId: number;
  filePath: string;
  contentHash: string;
  summary: string;
  concepts: string[];
  symbols: LLMSymbol[];
}

export function saveSnapshot(db: DB, data: FileSnapshotData): void {
  db.prepare(`
    INSERT INTO file_snapshots (run_id, project_id, file_path, content_hash, summary, concepts, symbols)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.runId, data.projectId, data.filePath, data.contentHash,
    data.summary, JSON.stringify(data.concepts), JSON.stringify(data.symbols)
  );
}

export function listSnapshots(db: DB, runId: number): FileSnapshot[] {
  return db.prepare('SELECT * FROM file_snapshots WHERE run_id = ? ORDER BY file_path')
    .all(runId) as FileSnapshot[];
}
