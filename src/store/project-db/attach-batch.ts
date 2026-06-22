/**
 * Fan-out federation for more projects than the ATTACH cap.
 *
 * Splits the target list into batches of `ATTACH_BATCH`, runs the per-batch
 * query on a fresh read-only central connection, and merges the results in JS
 * (per-DB FTS `bm25()` scores are not directly comparable across files, so the
 * merge step re-ranks/re-sorts).
 */
import type { DB } from '../db/types.js';
import { ATTACH_BATCH, withAttachedProjects, type AttachTarget } from './attach.js';

export interface FanOutOpts<R> {
  /** Open a fresh read-only central connection (one per batch; closed after). */
  centralOpener: () => DB;
  targets: AttachTarget[];
  /** Runs against one attached batch; receives the central DB + the live aliases. */
  perBatch: (db: DB, aliases: string[]) => R[];
  /** Merge/re-rank results gathered across all batches. Defaults to identity. */
  merge?: (all: R[]) => R[];
}

export function fanOutProjects<R>(opts: FanOutOpts<R>): R[] {
  const { centralOpener, targets, perBatch } = opts;
  const merge = opts.merge ?? ((all: R[]) => all);
  const out: R[] = [];
  for (let i = 0; i < targets.length; i += ATTACH_BATCH) {
    const batch = targets.slice(i, i + ATTACH_BATCH);
    const db = centralOpener();
    try {
      out.push(...withAttachedProjects(db, batch, perBatch));
    } finally {
      db.close();
    }
  }
  return merge(out);
}

/**
 * Probe the connection's real `SQLITE_MAX_ATTACHED` from compile options.
 * Returns the cap, or null if not advertised (older builds). Used by tests and
 * to log a warning if ATTACH_BATCH is ever set too high for the shipped build.
 */
export function attachedDbCap(db: DB): number | null {
  const rows = db.pragma('compile_options') as Array<{ compile_options: string }>;
  for (const r of rows) {
    const m = /^MAX_ATTACHED=(\d+)$/.exec(r.compile_options);
    if (m) return Number(m[1]);
  }
  return null;
}
