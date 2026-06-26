/**
 * explore_runs — telemetry for the `agent_explore` sub-agent: one row per run
 * with the tool-call trail (summarized), token usage (incl. cached), cost,
 * duration, stop reason, and the final markdown report. CENTRAL store (like
 * costs/runs). Self-contained types so the store layer doesn't depend on the
 * agent module.
 */
import type { DB } from './types.js';

export interface ExploreTrailEntry {
  name: string;
  args: Record<string, unknown>;
  ms: number;
  ok: boolean;
  outputBytes: number;
  snippet: string;
}

export interface InsertExploreRunData {
  projectId: number;
  task: string;
  model: string;
  status: string; // 'done' | 'error'
  stopReason: string;
  durationMs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  trail: ExploreTrailEntry[];
  report: string;
}

export interface ExploreRunRow {
  id: number;
  project_id: number;
  task: string;
  model: string;
  status: string;
  stop_reason: string;
  duration_ms: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd: number;
  trail: ExploreTrailEntry[];
  report: string;
  created_at: string;
}

/** Lightweight row for the list view (no heavy report/trail columns). */
export type ExploreRunListRow = Omit<ExploreRunRow, 'report' | 'trail'>;

interface RawRow extends Omit<ExploreRunRow, 'trail'> {
  trail: string;
}

export function insert(db: DB, d: InsertExploreRunData): number {
  const r = db
    .prepare(
      `INSERT INTO explore_runs
         (project_id, task, model, status, stop_reason, duration_ms, tool_calls,
          input_tokens, output_tokens, cached_input_tokens, cost_usd, trail, report)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.projectId,
      d.task,
      d.model,
      d.status,
      d.stopReason,
      d.durationMs,
      d.toolCalls,
      d.inputTokens,
      d.outputTokens,
      d.cachedInputTokens,
      d.costUsd,
      JSON.stringify(d.trail ?? []),
      d.report,
    );
  return Number(r.lastInsertRowid);
}

function hydrate(row: RawRow): ExploreRunRow {
  let trail: ExploreTrailEntry[] = [];
  try {
    trail = JSON.parse(row.trail ?? '[]') as ExploreTrailEntry[];
  } catch {
    /* keep [] */
  }
  return { ...row, trail };
}

export function get(db: DB, id: number): ExploreRunRow | undefined {
  const row = db.prepare('SELECT * FROM explore_runs WHERE id = ?').get(id) as RawRow | undefined;
  return row ? hydrate(row) : undefined;
}

/** Newest-first list for a project (omits the heavy report + trail columns). */
export function listByProject(db: DB, projectId: number, limit = 50): ExploreRunListRow[] {
  return db
    .prepare(
      `SELECT id, project_id, task, model, status, stop_reason, duration_ms, tool_calls,
              input_tokens, output_tokens, cached_input_tokens, cost_usd, created_at
       FROM explore_runs WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(projectId, limit) as ExploreRunListRow[];
}
