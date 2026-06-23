import type { DB } from './types.js';

export interface UpsertStructuralData {
  /** Project-relative, forward-slash path (scanner form). */
  path: string;
  language: string;
  size: number;
  lineCount: number;
  contentHash: string;
  /**
   * Import strings from tree-sitter (same shape files.upsert stores).
   * Omitted (language unsupported) → existing values are preserved on
   * UPDATE; INSERT defaults to empty.
   */
  dependencies?: string[];
  internalDeps?: string[];
  externalDeps?: string[];
  mtimeMs?: number | null;
}

/**
 * Structural-layer upsert — the ONLY write path the structural pipeline may
 * use on `files`. Unlike files.upsert (which overwrites every column and
 * would erase an earlier full-index's semantic layer), the UPDATE branch
 * touches structural columns only: summary/concepts/notes/complexity/layer/
 * flags/index_tier/semantic_hash/structure_hash all keep their values, so
 * `semantic_hash != content_hash` becomes the "semantics stale" marker.
 *
 * files_fts needs no maintenance on UPDATE (it indexes path/summary/concepts,
 * none of which change here); on INSERT the files_ai trigger covers it.
 */
export function upsertStructural(
  db: DB,
  projectId: number,
  data: UpsertStructuralData,
): { fileId: number; created: boolean } {
  const tx = db.transaction(() => {
    const existing = db.prepare(
      'SELECT id FROM files WHERE project_id = ? AND path = ?'
    ).get(projectId, data.path) as { id: number } | undefined;

    if (existing) {
      // COALESCE keeps the stored dependency JSON when tree-sitter didn't
      // produce any (unsupported language) — mirrors index_tier handling in
      // files.upsert.
      db.prepare(`
        UPDATE files SET
          language = ?, size = ?, line_count = ?, content_hash = ?,
          dependencies = COALESCE(?, dependencies),
          internal_deps = COALESCE(?, internal_deps),
          external_deps = COALESCE(?, external_deps),
          mtime_ms = COALESCE(?, mtime_ms),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        data.language, data.size, data.lineCount, data.contentHash,
        data.dependencies ? JSON.stringify(data.dependencies) : null,
        data.internalDeps ? JSON.stringify(data.internalDeps) : null,
        data.externalDeps ? JSON.stringify(data.externalDeps) : null,
        data.mtimeMs ?? null,
        existing.id
      );
      return { fileId: existing.id, created: false };
    }

    const result = db.prepare(`
      INSERT INTO files (project_id, path, language, size, line_count, content_hash,
        summary, concepts, dependencies, internal_deps, external_deps, notes, complexity,
        layer, is_entry_point, is_test, is_generated, mtime_ms)
      VALUES (?, ?, ?, ?, ?, ?, '', '[]', ?, ?, ?, '[]', 'unknown', 'unknown', 0, 0, 0, ?)
    `).run(
      projectId, data.path, data.language, data.size, data.lineCount, data.contentHash,
      JSON.stringify(data.dependencies ?? []), JSON.stringify(data.internalDeps ?? []),
      JSON.stringify(data.externalDeps ?? []),
      data.mtimeMs ?? null
    );
    return { fileId: result.lastInsertRowid as number, created: true };
  });

  return tx();
}

/**
 * Stamp the semantic layer as fresh for this content. Called by the FULL
 * pipeline only, inside its per-file transaction (both the LLM path and the
 * structure-hash llmSkipped path — in both cases the stored semantics
 * correspond to this exact content).
 */
export function setSemanticHash(db: DB, projectId: number, path: string, contentHash: string): void {
  db.prepare('UPDATE files SET semantic_hash = ? WHERE project_id = ? AND path = ?')
    .run(contentHash, projectId, path);
}

/**
 * Persist an LLM enrichment result (summary/concepts/layer) and stamp the
 * semantic_hash so the file is no longer stale. This is the only writer of the
 * semantic columns in this build (the structural pass preserves them).
 */
export function setFileSemantic(
  db: DB,
  projectId: number,
  path: string,
  data: { summary: string; concepts: string[]; layer: string; contentHash: string },
): void {
  db.prepare(
    'UPDATE files SET summary = ?, concepts = ?, layer = ?, semantic_hash = ? WHERE project_id = ? AND path = ?',
  ).run(data.summary, JSON.stringify(data.concepts), data.layer, data.contentHash, projectId, path);
}

export interface EnrichTarget {
  path: string;
  content_hash: string;
  language: string;
  line_count: number;
  indegree: number;
}

/**
 * Stale files ranked by importance (in-degree) — the enrichment pass spends its
 * budget on the most depended-on files first ("where it matters"). A re-run only
 * re-targets files that actually changed (semantic_hash diverged).
 */
export function listEnrichTargets(db: DB, projectId: number, limit: number): EnrichTarget[] {
  return db.prepare(`
    SELECT f.path AS path, f.content_hash AS content_hash, f.language AS language,
           f.line_count AS line_count, COALESCE(h.cnt, 0) AS indegree
    FROM files f
    LEFT JOIN (
      SELECT target_file_id, COUNT(*) AS cnt FROM file_dependencies
      WHERE project_id = ? AND target_file_id IS NOT NULL
      GROUP BY target_file_id
    ) h ON h.target_file_id = f.id
    WHERE f.project_id = ? AND (f.semantic_hash IS NULL OR f.semantic_hash != f.content_hash)
    ORDER BY indegree DESC, f.line_count DESC
    LIMIT ?
  `).all(projectId, projectId, limit) as EnrichTarget[];
}

/** Paths whose semantic layer lags the current content (or never existed). */
export function listSemanticStalePaths(db: DB, projectId: number, limit?: number): string[] {
  const rows = db.prepare(`
    SELECT path FROM files
    WHERE project_id = ? AND (semantic_hash IS NULL OR semantic_hash != content_hash)
    ORDER BY path
    ${limit ? 'LIMIT ?' : ''}
  `).all(...(limit ? [projectId, limit] : [projectId])) as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

export function countSemanticStale(db: DB, projectId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM files
    WHERE project_id = ? AND (semantic_hash IS NULL OR semantic_hash != content_hash)
  `).get(projectId) as { cnt: number };
  return row.cnt;
}
