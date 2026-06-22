/**
 * Verification gates for a project split (plan §8.9). ALL must pass before the
 * read path is allowed to flip to the project DB. Any failure → the caller
 * drops the project DB and marks the project 'failed' (central stays intact).
 */
import type { DB } from '../db/types.js';
import { manifestFor, type SplitClass } from './manifest.js';

export interface VerifyResult {
  ok: boolean;
  /** Human-readable reason when ok=false. */
  reason?: string;
  /** Per-table { project, central } counts for diagnostics. */
  counts: Record<string, { proj: number; central: number }>;
}

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

function count(db: DB, sql: string, params?: unknown): number {
  const row = (params === undefined ? db.prepare(sql).get() : db.prepare(sql).get(params)) as {
    n: number;
  };
  return row?.n ?? 0;
}

/**
 * @param proj    the freshly-copied project DB handle
 * @param central the legacy central DB handle
 * @param projectId
 */
export function verifySplit(
  proj: DB,
  central: DB,
  projectId: number,
  classes: SplitClass[] = ['INDEX'],
): VerifyResult {
  const counts: Record<string, { proj: number; central: number }> = {};

  // 1) Row-count parity — for DIRECT project_id tables only. Tables with a
  //    custom `where` (child/filtered/hybrid + the shared blob pool) use a
  //    legacy-qualified subquery that isn't expressible against the central
  //    handle here; they are trusted to the copy and covered by the FK +
  //    quick_check gates below.
  for (const entry of manifestFor(classes)) {
    if (entry.where) continue;
    if (!tableExists(proj, entry.table) || !tableExists(central, entry.table)) continue;
    const p = count(proj, `SELECT COUNT(*) n FROM "${entry.table}"`);
    const c = count(central, `SELECT COUNT(*) n FROM "${entry.table}" WHERE project_id = ?`, projectId);
    counts[entry.table] = { proj: p, central: c };
    if (p !== c) {
      return { ok: false, reason: `parity ${entry.table}: proj=${p} central=${c}`, counts };
    }
  }

  // 2) Foreign-key integrity (intra-file FKs only — projects row was copied).
  const fkViolations = proj.pragma('foreign_key_check') as unknown[];
  if (fkViolations.length > 0) {
    return { ok: false, reason: `foreign_key_check: ${fkViolations.length} violation(s)`, counts };
  }

  // 3) Structural integrity (quick).
  const quick = proj.pragma('quick_check', { simple: true });
  if (quick !== 'ok') {
    return { ok: false, reason: `quick_check: ${String(quick)}`, counts };
  }

  return { ok: true, counts };
}
