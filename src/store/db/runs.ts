import type { IndexRun, RunStatus } from '@ctx/shared/types.js';
import type { DB } from './types.js';

export interface FinishRunData {
  status: RunStatus;
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
  estimatedCostUsd: number;
  /** JSON `{scan_ms, analyze_ms, embed_ms, sweep_ms}` (migration 138). */
  phaseTimingsJson?: string;
  peakRssMb?: number;
}

export function start(
  db: DB,
  projectId: number,
  provider?: string,
  model?: string,
  kind: 'full' | 'structural' = 'full',
): number {
  const result = db.prepare(`
    INSERT INTO runs (project_id, provider, model, kind)
    VALUES (?, ?, ?, ?)
  `).run(projectId, provider ?? null, model ?? null, kind);
  return result.lastInsertRowid as number;
}

export function finish(db: DB, runId: number, data: FinishRunData): void {
  db.prepare(`
    UPDATE runs SET
      finished_at = datetime('now'), status = ?,
      total_files = ?, indexed_files = ?, skipped_files = ?, error_count = ?,
      input_tokens = ?, output_tokens = ?, embedding_tokens = ?, estimated_cost_usd = ?,
      phase_timings_json = ?, peak_rss_mb = ?
    WHERE id = ?
  `).run(
    data.status, data.totalFiles, data.indexedFiles, data.skippedFiles, data.errorCount,
    data.inputTokens, data.outputTokens, data.embeddingTokens, data.estimatedCostUsd,
    data.phaseTimingsJson ?? null, data.peakRssMb ?? null,
    runId
  );
}

export function get(db: DB, id: number): IndexRun | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as IndexRun | undefined;
}

export function list(db: DB, projectId: number, limit: number = 20): IndexRun[] {
  return db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(projectId, limit) as IndexRun[];
}
