import type { DBFile, ProjectStats, Project } from '@ctx/shared/types.js';
import type { DB } from './types.js';

/**
 * @param db        project-scoped handle (files/symbols live in the project DB
 *                  when the tiered-hybrid split routes this project).
 * @param centralDb central handle — `runs` stays CENTRAL (telemetry/stats), so
 *                  the run count must come from there, not the project DB.
 */
export function projectStats(db: DB, centralDb: DB, projectId: number, project: Project | undefined): ProjectStats {
  const fileCounts = db.prepare(`
    SELECT COUNT(*) as file_count, COALESCE(SUM(line_count), 0) as total_lines, COALESCE(SUM(size), 0) as total_size
    FROM files WHERE project_id = ?
  `).get(projectId) as { file_count: number; total_lines: number; total_size: number };

  const symbolCount = db.prepare('SELECT COUNT(*) as cnt FROM symbols WHERE project_id = ?')
    .get(projectId) as { cnt: number };

  const languages = db.prepare(`
    SELECT language, COUNT(*) as cnt FROM files WHERE project_id = ? GROUP BY language ORDER BY cnt DESC
  `).all(projectId) as Array<{ language: string; cnt: number }>;

  const runCount = centralDb.prepare('SELECT COUNT(*) as cnt FROM runs WHERE project_id = ?')
    .get(projectId) as { cnt: number };

  const staleSemantic = db.prepare(`
    SELECT COUNT(*) as cnt FROM files
    WHERE project_id = ? AND (semantic_hash IS NULL OR semantic_hash != content_hash)
  `).get(projectId) as { cnt: number };

  return {
    file_count: fileCounts.file_count,
    symbol_count: symbolCount.cnt,
    languages: Object.fromEntries(languages.map(l => [l.language, l.cnt])),
    total_lines: fileCounts.total_lines,
    total_size: fileCounts.total_size,
    last_indexed: project?.last_indexed ?? null,
    structural_indexed_at: project?.structural_indexed_at ?? null,
    semantic_stale_count: staleSemantic.cnt,
    run_count: runCount.cnt,
  };
}

export function listConcepts(db: DB, projectId: number): Array<{ concept: string; count: number }> {
  return db.prepare(`
    SELECT concept, COUNT(*) as count
    FROM file_concepts
    WHERE project_id = ?
    GROUP BY concept
    ORDER BY count DESC
  `).all(projectId) as Array<{ concept: string; count: number }>;
}

export function getFilesByConcept(db: DB, projectId: number, concept: string): DBFile[] {
  return db.prepare(`
    SELECT f.* FROM files f
    JOIN file_concepts fc ON fc.file_id = f.id
    WHERE fc.project_id = ? AND fc.concept = ?
    ORDER BY f.path
  `).all(projectId, concept) as DBFile[];
}

export function getLastTwoRunIds(db: DB, projectId: number): [number, number] | null {
  // Full runs only — structural runs write no file_snapshots, so pairing one
  // would produce an empty/false diff.
  const runs = db.prepare(
    "SELECT id FROM runs WHERE project_id = ? AND status = 'completed' AND kind = 'full' ORDER BY started_at DESC LIMIT 2"
  ).all(projectId) as Array<{ id: number }>;

  if (runs.length < 2) return null;
  return [runs[1].id, runs[0].id];
}

export function getFilesByLayer(db: DB, projectId: number, layer: string): DBFile[] {
  return db.prepare('SELECT * FROM files WHERE project_id = ? AND layer = ? ORDER BY path')
    .all(projectId, layer) as DBFile[];
}

export function getArchitectureOverview(db: DB, projectId: number): Array<{ layer: string; count: number }> {
  return db.prepare(`
    SELECT layer, COUNT(*) as count
    FROM files WHERE project_id = ?
    GROUP BY layer ORDER BY count DESC
  `).all(projectId) as Array<{ layer: string; count: number }>;
}
