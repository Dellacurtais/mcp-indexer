/**
 * `ProjectDb` — one SQLite connection to a single project's DB file.
 *
 * The per-project analog of `CodeIndexDB`, but deliberately WITHOUT domain
 * methods: the data-access functions in `db/*` already take a raw `DB`, so the
 * routing façade feeds them `ProjectDb.raw()`. This class owns only connection
 * lifecycle, schema bootstrap, and checkpointing.
 */
import type { DB } from '../db/types.js';
import { openRawProjectDb, type OpenProjectDbOpts } from './open.js';
import { initProjectSchema } from './project-schema.js';

/** Injectable clock so the pure-ish lib never calls Date.now() directly. */
export type NowFn = () => number;

export class ProjectDb {
  readonly projectId: number;
  readonly dbPath: string;
  private db: DB;
  private readonly now: NowFn;
  private lastUsedAt: number;

  constructor(projectId: number, dbPath: string, opts: OpenProjectDbOpts & { now?: NowFn } = {}) {
    this.projectId = projectId;
    this.dbPath = dbPath;
    this.now = opts.now ?? Date.now;
    this.db = openRawProjectDb(dbPath, opts);
    if (!opts.readonly) initProjectSchema(this.db);
    this.lastUsedAt = this.now();
  }

  raw(): DB {
    return this.db;
  }

  touch(): void {
    this.lastUsedAt = this.now();
  }

  get idleMs(): number {
    return this.now() - this.lastUsedAt;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Flush + shrink the WAL to zero, then close. Called by the pool on evict/idle. */
  checkpointAndClose(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* best-effort */
    }
    this.db.close();
  }

  /** Non-blocking passive checkpoint (workers use this; never TRUNCATE). */
  passiveCheckpoint(): void {
    try {
      this.db.pragma('wal_checkpoint(PASSIVE)');
    } catch {
      /* best-effort */
    }
  }

  close(): void {
    this.db.close();
  }
}
