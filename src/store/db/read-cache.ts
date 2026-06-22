/**
 * Synchronous read-through cache for the DB facade's hottest read-mostly
 * methods. better-sqlite3 is SYNCHRONOUS and runs on the Electron main thread,
 * so a heavy read (e.g. getStats scanning the whole files table — 50-200ms on a
 * large project) BLOCKS every other IPC while it runs → the whole app "trava
 * todas as telas" on project open. Memoizing collapses the burst of repeated
 * reads on open and makes navigation / re-open instant.
 *
 * SHORT TTL, not pure invalidate-on-write, on purpose: the indexer/embeddings
 * WORKERS write to the same DB files directly (their writes never pass through
 * this facade), so a main-side cache can't observe them. A few-second TTL
 * bounds staleness and self-heals cross-process; main-side writes invalidate
 * eagerly on top for immediacy. Keys are `scope:projectId` (or a fixed key);
 * `invalidateProject` drops every entry for one project.
 *
 * Injectable clock keeps it unit-testable without real time.
 */
export class ReadCache {
  private readonly store = new Map<string, { value: unknown; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Return the cached value if fresh, else compute, store, and return it. */
  get<T>(key: string, ttlMs: number, compute: () => T): T {
    const hit = this.store.get(key);
    if (hit && this.now() - hit.at < ttlMs) return hit.value as T;
    const value = compute();
    this.store.set(key, { value, at: this.now() });
    return value;
  }

  /** Overwrite a key with a freshly-computed value (used by the `fresh` bypass
   *  so an accuracy-critical caller refreshes the cache with the truth). */
  set<T>(key: string, value: T): void {
    this.store.set(key, { value, at: this.now() });
  }

  /** Drop one exact key. */
  invalidateKey(key: string): void {
    this.store.delete(key);
  }

  /**
   * Drop every entry scoped to a project. Matches the LAST colon segment for
   * equality (not an `endsWith`), so a key MUST end with `:<numericProjectId>`
   * for this to hit it — `stats:12` is never dropped by `invalidateProject(1)`,
   * and `projects:list` (segment `list`) is never matched. A future
   * multi-segment key (`stats:1:lang`) simply won't match the id rather than
   * being mis-dropped.
   */
  invalidateProject(id: number): void {
    const target = String(id);
    for (const k of this.store.keys()) {
      const i = k.lastIndexOf(':');
      if (i !== -1 && k.slice(i + 1) === target) this.store.delete(k);
    }
  }

  clear(): void {
    this.store.clear();
  }
}
