/**
 * memory_distill_log (migration 136) — diagnostics for the project-memory
 * write-back. Every distillation attempt lands here (ok / empty / error /
 * skipped, with created/merged/skipped counts), so the dashboard "memory
 * health" card can show WHEN the project last learned something and WHY a
 * silent period happened — the antidote to the pipeline failing invisibly.
 */
import type { DB } from './types.js';

export type DistillTrigger = 'compaction' | 'manual_clear' | 'idle' | 'agent' | 'promotion' | 'consolidation';
export type DistillStatus = 'ok' | 'empty' | 'error' | 'skipped';

export interface MemoryDistillLogEntry {
  sessionId?: number | null;
  trigger: DistillTrigger | string;
  status: DistillStatus | string;
  created?: number;
  merged?: number;
  skipped?: number;
  error?: string | null;
}

export interface MemoryDistillLogRow {
  id: number;
  project_id: number;
  session_id: number | null;
  trigger: string;
  status: string;
  created: number;
  merged: number;
  skipped: number;
  error: string | null;
  created_at: string;
}

export function insert(db: DB, projectId: number, entry: MemoryDistillLogEntry): void {
  db.prepare(`
    INSERT INTO memory_distill_log (project_id, session_id, trigger, status, created, merged, skipped, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId,
    entry.sessionId ?? null,
    entry.trigger,
    entry.status,
    entry.created ?? 0,
    entry.merged ?? 0,
    entry.skipped ?? 0,
    entry.error ?? null,
  );
}

export function latestForProject(db: DB, projectId: number): MemoryDistillLogRow | null {
  const row = db.prepare(
    'SELECT * FROM memory_distill_log WHERE project_id = ? ORDER BY id DESC LIMIT 1',
  ).get(projectId) as MemoryDistillLogRow | undefined;
  return row ?? null;
}

export function recentForProject(db: DB, projectId: number, limit = 20): MemoryDistillLogRow[] {
  return db.prepare(
    'SELECT * FROM memory_distill_log WHERE project_id = ? ORDER BY id DESC LIMIT ?',
  ).all(projectId, Math.max(1, Math.min(100, limit))) as MemoryDistillLogRow[];
}

/** Memory totals by snapshot category (live only) — feeds the health card. */
export function countSnapshotsByCategory(db: DB, projectId: number): Record<string, number> {
  const rows = db.prepare(
    'SELECT category, COUNT(*) AS c FROM snapshots WHERE project_id = ? AND archived_at IS NULL GROUP BY category',
  ).all(projectId) as Array<{ category: string; c: number }>;
  return Object.fromEntries(rows.map((r) => [r.category, r.c]));
}

/** Memory totals by provenance (`source`, migration 114; live only) — feeds the health card. */
export function countSnapshotsBySource(db: DB, projectId: number): Record<string, number> {
  const rows = db.prepare(
    'SELECT source, COUNT(*) AS c FROM snapshots WHERE project_id = ? AND archived_at IS NULL GROUP BY source',
  ).all(projectId) as Array<{ source: string; c: number }>;
  return Object.fromEntries(rows.map((r) => [r.source, r.c]));
}
