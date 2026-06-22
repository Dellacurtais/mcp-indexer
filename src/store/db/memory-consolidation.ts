import type { DB } from './types.js';

/**
 * Project selection for the periodic memory consolidator (Workstream B).
 *
 * A project is a candidate when:
 *   - it has live snapshots to consolidate;
 *   - it is IDLE — no running session, and no session touched within the idle
 *     window (so we never merge rows a live run is actively writing);
 *   - it CHANGED since the last consolidation — its newest live snapshot is
 *     more recent than the last `consolidation` log row (skip-if-unchanged, so
 *     re-runs over a settled project are no-ops at the scheduler level).
 *
 * The hidden user-memory project (id 0) has no sessions, so it passes the idle
 * gate naturally and gets its near-duplicate preferences merged too.
 */
export interface ConsolidationCandidate {
  project_id: number;
  project_name: string;
}

export function listConsolidationCandidates(
  db: DB,
  idleSeconds: number,
  limit: number,
): ConsolidationCandidate[] {
  return db.prepare(`
    SELECT p.id AS project_id, p.name AS project_name
    FROM projects p
    WHERE EXISTS (
      SELECT 1 FROM snapshots s WHERE s.project_id = p.id AND s.archived_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM coder_sessions cs
      WHERE cs.project_id = p.id
        AND (cs.status = 'running'
             OR cs.updated_at >= datetime('now', '-' || CAST(? AS INTEGER) || ' seconds'))
    )
    AND (
      SELECT MAX(s.updated_at) FROM snapshots s
      WHERE s.project_id = p.id AND s.archived_at IS NULL
    ) > COALESCE((
      SELECT MAX(l.created_at) FROM memory_distill_log l
      WHERE l.project_id = p.id AND l.trigger = 'consolidation'
    ), '0000-00-00')
    LIMIT ?
  `).all(idleSeconds, Math.max(1, limit)) as ConsolidationCandidate[];
}
