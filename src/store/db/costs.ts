import type { CostSummary } from '@ctx/shared/types.js';
import type { DB } from './types.js';

export interface InsertCostData {
  projectId: number;
  runId?: number;
  provider: string;
  model: string;
  operation: 'analysis' | 'embedding';
  filePath?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RunCostSummary {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  embedding_tokens: number;
}

export function insert(db: DB, data: InsertCostData): void {
  db.prepare(`
    INSERT INTO costs (project_id, run_id, provider, model, operation, file_path, input_tokens, output_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.projectId, data.runId ?? null, data.provider, data.model, data.operation,
    data.filePath ?? null, data.inputTokens, data.outputTokens, data.costUsd
  );
}

export function projectSummary(db: DB, projectId: number, since?: string): CostSummary {
  const whereClause = since ? 'WHERE project_id = ? AND created_at >= ?' : 'WHERE project_id = ?';
  const params = since ? [projectId, since] : [projectId];

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as total_cost_usd,
      COALESCE(SUM(CASE WHEN operation = 'analysis' THEN cost_usd ELSE 0 END), 0) as llm_analysis_cost_usd,
      COALESCE(SUM(CASE WHEN operation = 'embedding' THEN cost_usd ELSE 0 END), 0) as embedding_cost_usd,
      COALESCE(SUM(CASE WHEN operation = 'analysis' THEN input_tokens ELSE 0 END), 0) as total_input_tokens,
      COALESCE(SUM(CASE WHEN operation = 'analysis' THEN output_tokens ELSE 0 END), 0) as total_output_tokens,
      COALESCE(SUM(CASE WHEN operation = 'embedding' THEN input_tokens ELSE 0 END), 0) as total_embedding_tokens,
      COUNT(DISTINCT run_id) as runs
    FROM costs ${whereClause}
  `).get(...params) as Record<string, number>;

  const byProvider = db.prepare(`
    SELECT provider,
      COALESCE(SUM(cost_usd), 0) as cost_usd,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM costs ${whereClause}
    GROUP BY provider
  `).all(...params) as Array<{ provider: string; cost_usd: number; input_tokens: number; output_tokens: number }>;

  return {
    total_cost_usd: totals.total_cost_usd,
    llm_analysis_cost_usd: totals.llm_analysis_cost_usd,
    embedding_cost_usd: totals.embedding_cost_usd,
    total_input_tokens: totals.total_input_tokens,
    total_output_tokens: totals.total_output_tokens,
    total_embedding_tokens: totals.total_embedding_tokens,
    runs: totals.runs,
    by_provider: Object.fromEntries(
      byProvider.map(p => [p.provider, { cost_usd: p.cost_usd, input_tokens: p.input_tokens, output_tokens: p.output_tokens }])
    ),
    by_project: {},
  };
}

export function globalSummary(db: DB, since?: string): CostSummary {
  const whereClause = since ? 'WHERE created_at >= ?' : '';
  const params = since ? [since] : [];

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as total_cost_usd,
      COALESCE(SUM(CASE WHEN operation = 'analysis' THEN cost_usd ELSE 0 END), 0) as llm_analysis_cost_usd,
      COALESCE(SUM(CASE WHEN operation = 'embedding' THEN cost_usd ELSE 0 END), 0) as embedding_cost_usd,
      COALESCE(SUM(CASE WHEN operation = 'analysis' THEN input_tokens ELSE 0 END), 0) as total_input_tokens,
      COALESCE(SUM(CASE WHEN operation = 'analysis' THEN output_tokens ELSE 0 END), 0) as total_output_tokens,
      COALESCE(SUM(CASE WHEN operation = 'embedding' THEN input_tokens ELSE 0 END), 0) as total_embedding_tokens,
      COUNT(DISTINCT run_id) as runs
    FROM costs ${whereClause}
  `).get(...params) as Record<string, number>;

  const byProvider = db.prepare(`
    SELECT provider,
      COALESCE(SUM(cost_usd), 0) as cost_usd,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM costs ${whereClause}
    GROUP BY provider
  `).all(...params) as Array<{ provider: string; cost_usd: number; input_tokens: number; output_tokens: number }>;

  const byProject = db.prepare(`
    SELECT p.name, COALESCE(SUM(c.cost_usd), 0) as cost_usd, COUNT(DISTINCT c.run_id) as runs
    FROM costs c JOIN projects p ON p.id = c.project_id
    ${whereClause ? whereClause.replace('created_at', 'c.created_at') : ''}
    GROUP BY p.name
  `).all(...params) as Array<{ name: string; cost_usd: number; runs: number }>;

  return {
    total_cost_usd: totals.total_cost_usd,
    llm_analysis_cost_usd: totals.llm_analysis_cost_usd,
    embedding_cost_usd: totals.embedding_cost_usd,
    total_input_tokens: totals.total_input_tokens,
    total_output_tokens: totals.total_output_tokens,
    total_embedding_tokens: totals.total_embedding_tokens,
    runs: totals.runs,
    by_provider: Object.fromEntries(
      byProvider.map(p => [p.provider, { cost_usd: p.cost_usd, input_tokens: p.input_tokens, output_tokens: p.output_tokens }])
    ),
    by_project: Object.fromEntries(
      byProject.map(p => [p.name, { cost_usd: p.cost_usd, runs: p.runs }])
    ),
  };
}

export function runSummary(db: DB, runId: number): RunCostSummary {
  return db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as cost_usd,
      COALESCE(SUM(CASE WHEN operation = 'analysis' THEN input_tokens ELSE 0 END), 0) as input_tokens,
      COALESCE(SUM(CASE WHEN operation = 'analysis' THEN output_tokens ELSE 0 END), 0) as output_tokens,
      COALESCE(SUM(CASE WHEN operation = 'embedding' THEN input_tokens ELSE 0 END), 0) as embedding_tokens
    FROM costs WHERE run_id = ?
  `).get(runId) as RunCostSummary;
}
