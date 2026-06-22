/**
 * Single low-level opener for per-project SQLite DBs.
 *
 * This is the ONE place project DB connections are configured, shared by the
 * main-process pool, every worker thread, and the per-project vector store, so
 * the pragmas can never drift (today they are copy-pasted in ~6 places). Mirrors
 * the central `CodeIndexDB` constructor pragmas (`db.ts`) + `applyTuningPragmas`.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database, type DB } from '../db/types.js';
import { applyTuningPragmas } from '../db/pragmas.js';

export interface OpenProjectDbOpts {
  readonly?: boolean;
  /**
   * Disable WAL auto-checkpoint so the pool can checkpoint deterministically
   * (main pool TRUNCATEs on idle/evict; workers only PASSIVE). Default true for
   * writable handles. Ignored for readonly handles.
   */
  manualCheckpoint?: boolean;
}

export function openRawProjectDb(dbPath: string, opts: OpenProjectDbOpts = {}): DB {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { readonly: !!opts.readonly });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = 10000');
  db.pragma('foreign_keys = ON'); // intra-file FKs still enforced
  applyTuningPragmas(db); // busy_timeout / temp_store / mmap — shared with index.db
  if (opts.manualCheckpoint !== false && !opts.readonly) {
    db.pragma('wal_autocheckpoint = 0');
  }
  return db;
}
