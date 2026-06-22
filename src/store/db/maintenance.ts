import type { DB } from './types.js';

export interface ProjectHygieneRow {
  id: number;
  name: string;
  root_path: string;
  pending_vector_gc: number;
  file_count: number;
  vector_count: number;
  orphan_vector_ids: number;
  stale_runs: number;
  duplicate_vector_ids: number;
  mixed_case_languages: number;
}

export function listProjectsHygiene(db: DB): ProjectHygieneRow[] {
  return db.prepare(`
    SELECT
      p.id,
      p.name,
      p.root_path,
      COALESCE(p.pending_vector_gc, 0) AS pending_vector_gc,
      (SELECT COUNT(*) FROM files f WHERE f.project_id = p.id) AS file_count,
      (SELECT COUNT(*) FROM vector_ids v WHERE v.project_id = p.id) AS vector_count,
      (SELECT COUNT(*) FROM vector_ids v
        WHERE v.project_id = p.id
          AND v.file_path IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM files f
            WHERE f.project_id = v.project_id AND f.path = v.file_path
          )
      ) AS orphan_vector_ids,
      (SELECT COUNT(*) FROM runs r
        WHERE r.project_id = p.id
          AND r.status = 'running'
          AND r.started_at < datetime('now', '-2 hours')
      ) AS stale_runs,
      (SELECT COALESCE(SUM(c - 1), 0) FROM (
          SELECT COUNT(*) AS c FROM vector_ids v
           WHERE v.project_id = p.id
           GROUP BY v.vector_id HAVING COUNT(*) > 1
      )) AS duplicate_vector_ids,
      (SELECT COUNT(*) FROM files f
        WHERE f.project_id = p.id AND f.language <> LOWER(f.language)
      ) AS mixed_case_languages
    FROM projects p
    ORDER BY p.name
  `).all() as ProjectHygieneRow[];
}

/**
 * In-degree per file path — how many other files in this project import it.
 * Built from file_dependencies; reflects the previous indexing run.
 * Used by the auto-mapper to promote heavily-imported files from support→core.
 */
export function getFileIndegrees(db: DB, projectId: number): Map<string, number> {
  const rows = db.prepare(`
    SELECT f.path AS path, COUNT(*) AS indegree
    FROM file_dependencies fd
    JOIN files f ON f.id = fd.target_file_id
    WHERE fd.project_id = ? AND fd.target_file_id IS NOT NULL
    GROUP BY f.path
  `).all(projectId) as Array<{ path: string; indegree: number }>;
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.path, r.indegree);
  return out;
}

export function getProjectTierBreakdown(db: DB): Array<{ project_id: number; tier: string; count: number }> {
  return db.prepare(`
    SELECT
      project_id,
      COALESCE(index_tier, 'untagged') AS tier,
      COUNT(*) AS count
    FROM files
    GROUP BY project_id, tier
  `).all() as Array<{ project_id: number; tier: string; count: number }>;
}

export function normalizeFileLanguages(db: DB, projectId?: number): number {
  const stmt = projectId != null
    ? db.prepare(
        `UPDATE files SET language = LOWER(language)
          WHERE language <> LOWER(language) AND project_id = ?`,
      )
    : db.prepare(
        `UPDATE files SET language = LOWER(language)
          WHERE language <> LOWER(language)`,
      );
  const result = projectId != null ? stmt.run(projectId) : stmt.run();
  return result.changes;
}

export function markStaleRuns(db: DB, olderThanHours = 2, projectId?: number): number {
  const sql = `
    UPDATE runs
    SET status = 'abandoned',
        finished_at = COALESCE(finished_at, datetime('now'))
    WHERE status = 'running'
      AND started_at < datetime('now', '-' || ? || ' hours')
      ${projectId != null ? 'AND project_id = ?' : ''}
  `;
  const stmt = db.prepare(sql);
  const result = projectId != null ? stmt.run(olderThanHours, projectId) : stmt.run(olderThanHours);
  return result.changes;
}

export function setProjectPendingVectorGc(db: DB, projectId: number, pending: boolean): void {
  db.prepare('UPDATE projects SET pending_vector_gc = ? WHERE id = ?').run(pending ? 1 : 0, projectId);
}
