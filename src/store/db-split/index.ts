/**
 * Lazy backfill driver — splits one project's data out of the central DB into
 * its own project DB, crash-safe (plan §8.3 state machine).
 *
 * State machine (marker = projects.db_split_status):
 *   pending → copying → copied → verified → done    (purge deferred by default)
 *   any failure → failed (retried up to MAX_ATTEMPTS, then sticks)
 *
 * Safety: copy → verify → flip → (deferred) purge. The central rows are the
 * durable copy; nothing is destroyed here (purge lives in a later pass). A
 * crash mid-copy leaves status 'copying' over a partial file → recovery deletes
 * the file and restarts from scratch (idempotent).
 */
import { existsSync, rmSync } from 'node:fs';
import type { DB } from '../db/types.js';
import { copyProjectData } from './copy-engine.js';
import { verifySplit } from './verify.js';
import { ensureCentralBackup } from './backup.js';
import type { SplitClass } from './manifest.js';

const MAX_ATTEMPTS = 3;
const TERMINAL = new Set(['done']);

export interface SplitDeps {
  /** Central DB handle — source for the copy + marker store. */
  central: DB;
  /** Central DB file path — for ATTACH + the one-time backup. */
  centralDbPath: string;
  /** Target project DB file path. */
  projectDbPath: string;
  projectId: number;
  /** Opens a fresh project DB at `path` with the full schema applied. */
  openFreshProjectDb: (path: string) => DB;
  classes?: SplitClass[];
  /** When 'immediate', purge central rows after verify. Default: defer (no purge). */
  purgeMode?: 'defer' | 'immediate';
}

export interface SplitOutcome {
  status: 'done' | 'failed' | 'skipped';
  reason?: string;
  copied?: number;
}

function readStatus(central: DB, projectId: number): { status: string; attempts: number; synthetic: boolean } {
  const row = central.prepare(
    `SELECT db_split_status AS s, db_split_attempts AS a, COALESCE(is_synthetic,0) AS syn
       FROM projects WHERE id = ?`,
  ).get(projectId) as { s?: string; a?: number; syn?: number } | undefined;
  return { status: row?.s ?? 'pending', attempts: row?.a ?? 0, synthetic: row?.syn === 1 };
}

function setStatus(central: DB, projectId: number, status: string, err?: string | null): void {
  central.prepare(
    `UPDATE projects SET db_split_status = ?, db_split_at = datetime('now'), db_split_err = ?
       WHERE id = ?`,
  ).run(status, err ?? null, projectId);
}

function bumpAttempts(central: DB, projectId: number): void {
  central.prepare(`UPDATE projects SET db_split_attempts = db_split_attempts + 1 WHERE id = ?`)
    .run(projectId);
}

function removeDbFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      if (existsSync(path + suffix)) rmSync(path + suffix, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Run (or resume) the split for one project. Safe to call repeatedly: it
 * no-ops once 'done', and recovers a crashed 'copying' by restarting clean.
 */
export function splitProject(deps: SplitDeps): SplitOutcome {
  const { central, centralDbPath, projectDbPath, projectId } = deps;
  const classes = deps.classes ?? ['INDEX'];
  const { status, attempts, synthetic } = readStatus(central, projectId);

  if (projectId === 0 || synthetic) return { status: 'skipped', reason: 'sentinel/synthetic' };
  if (TERMINAL.has(status)) return { status: 'done' };
  if (status === 'failed' && attempts >= MAX_ATTEMPTS) {
    return { status: 'failed', reason: 'max attempts reached' };
  }

  // One-time backup before we ever write a project DB in this session.
  try {
    const schemaVersion = (central.prepare(`SELECT MAX(version) v FROM schema_version`).get() as { v: number }).v;
    ensureCentralBackup(central, centralDbPath, schemaVersion);
  } catch {
    /* backup is best-effort safety; do not block the split if disk is tight */
  }

  // Fresh start: discard any partial project DB from a prior crash.
  removeDbFiles(projectDbPath);
  bumpAttempts(central, projectId);
  setStatus(central, projectId, 'copying');

  let proj: DB | null = null;
  try {
    proj = deps.openFreshProjectDb(projectDbPath);
    const copy = copyProjectData(proj, centralDbPath, projectId, classes);
    setStatus(central, projectId, 'copied');

    const verdict = verifySplit(proj, central, projectId, classes);
    if (!verdict.ok) {
      proj.close();
      proj = null;
      removeDbFiles(projectDbPath);
      setStatus(central, projectId, 'failed', verdict.reason);
      return { status: 'failed', reason: verdict.reason };
    }

    setStatus(central, projectId, 'verified');
    // Purge is deferred by default (reversible soak window). 'immediate' mode
    // would delete central rows here in a later iteration (P5+); kept inert now.
    setStatus(central, projectId, 'done');
    return { status: 'done', copied: copy.total };
  } catch (e) {
    if (proj) {
      try { proj.close(); } catch { /* ignore */ }
      proj = null;
    }
    removeDbFiles(projectDbPath);
    const reason = (e as Error).message;
    setStatus(central, projectId, 'failed', reason);
    return { status: 'failed', reason };
  } finally {
    if (proj) {
      try { proj.close(); } catch { /* ignore */ }
    }
  }
}

export { copyProjectData } from './copy-engine.js';
export { verifySplit, type VerifyResult } from './verify.js';
export { ensureCentralBackup, backupPathFor } from './backup.js';
export { INDEX_TABLES, manifestFor, type SplitClass, type ManifestEntry } from './manifest.js';
export {
  splitProjectVectors,
  verifyVectorParity,
  centralVectorsPath,
  projectVectorsPath,
  type VectorsSplitOutcome,
  type VectorsSplitDeps,
  type VecParity,
} from './vectors-split.js';
export { purgeProjectIndex, vacuumCentral, type PurgeResult } from './purge.js';
