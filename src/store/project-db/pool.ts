/**
 * `ProjectDbPool` — per-process LRU cache of open project DB connections.
 *
 * better-sqlite3 is synchronous and single-connection-per-thread, so there is
 * no cross-thread sharing: the main process holds one pool, each worker holds
 * its own. Cross-thread safety over the SAME file is delegated entirely to WAL
 * + busy_timeout (exactly as the central index.db works today).
 *
 * Checkpoint policy: writable handles open with wal_autocheckpoint=0; the pool
 * TRUNCATEs on evict/idle so an idle project leaves a clean single .db (no
 * lingering -wal). The optional idle sweeper bounds open handles + WAL growth.
 */
import { ProjectDb, type NowFn } from './handle.js';
import type { OpenProjectDbOpts } from './open.js';

export interface ProjectDbPoolOpts {
  /** Resolve a project id to its DB path. Injected to avoid a store import cycle. */
  resolve: (projectId: number) => { dbPath: string };
  /** Max open handles; kept < ATTACH cap so federation can still attach. Default 8. */
  maxOpen?: number;
  /** Evict + checkpoint(TRUNCATE) handles idle longer than this. Default 60s. */
  idleTtlMs?: number;
  readonly?: boolean;
  now?: NowFn;
  openOpts?: OpenProjectDbOpts;
}

export class ProjectDbPool {
  /** Insertion-ordered Map doubles as the LRU recency list. */
  private readonly entries = new Map<number, ProjectDb>();
  private readonly opts: Required<Pick<ProjectDbPoolOpts, 'maxOpen' | 'idleTtlMs'>> & ProjectDbPoolOpts;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ProjectDbPoolOpts) {
    this.opts = { maxOpen: 8, idleTtlMs: 60_000, ...opts };
  }

  /** Get (opening if needed) the handle for a project; bumps LRU recency. */
  get(projectId: number): ProjectDb {
    const hit = this.entries.get(projectId);
    if (hit) {
      hit.touch();
      this.bump(projectId);
      return hit;
    }
    const { dbPath } = this.opts.resolve(projectId);
    const pdb = new ProjectDb(projectId, dbPath, {
      ...this.opts.openOpts,
      readonly: this.opts.readonly,
      now: this.opts.now,
    });
    this.entries.set(projectId, pdb);
    this.evictOverCap();
    return pdb;
  }

  has(projectId: number): boolean {
    return this.entries.has(projectId);
  }

  /** Close + drop a single project (checkpoint TRUNCATE first). */
  evict(projectId: number): void {
    const pdb = this.entries.get(projectId);
    if (!pdb) return;
    this.entries.delete(projectId);
    pdb.checkpointAndClose();
  }

  /** Evict every handle idle longer than the TTL. */
  sweepIdle(): void {
    for (const [id, pdb] of [...this.entries]) {
      if (pdb.idleMs > this.opts.idleTtlMs) {
        this.entries.delete(id);
        pdb.checkpointAndClose();
      }
    }
  }

  /** Start a background idle sweep. No-op if already running. */
  startSweeper(intervalMs = 30_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweepIdle(), intervalMs);
    this.sweeper.unref?.();
  }

  /** Close all handles and stop the sweeper. Call on process shutdown. */
  closeAll(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    for (const pdb of this.entries.values()) pdb.checkpointAndClose();
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private bump(id: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.entries.set(id, e);
  }

  private evictOverCap(): void {
    while (this.entries.size > this.opts.maxOpen) {
      const oldest = this.entries.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      const pdb = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      pdb.checkpointAndClose();
    }
  }
}
