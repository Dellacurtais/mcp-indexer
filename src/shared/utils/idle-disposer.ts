/**
 * Lazy resource with idle-TTL eviction and transparent re-creation.
 *
 * Wraps something expensive to keep in memory (an ONNX session, a pool of
 * WASM parsers) so that it is created on first use, shared by concurrent
 * users, and destroyed after `idleTtlMs` without callers — the next
 * `acquire` re-creates it transparently. Designed for long-lived desktop
 * processes where "loaded forever after first use" is the leak.
 *
 * Concurrency contract:
 *  - `acquire` holds a refcount for the duration of `fn`; the resource is
 *    NEVER destroyed while any `fn` is in flight (destroying a native
 *    session mid-call crashes the process, not just the promise).
 *  - Concurrent first uses share one in-flight `create()`.
 *  - A failed `create()` is not memoized — the next `acquire` retries.
 *  - The idle timer is unref'd: an armed TTL never keeps the process alive.
 *  - `dispose()` (manual eviction / shutdown) waits for in-flight users,
 *    then destroys; it is idempotent and the resource may be re-acquired
 *    afterwards (callers at shutdown simply never acquire again).
 *  - A generation counter guards the timer callback against the ABA race
 *    (timer fires after a newer acquire/destroy already changed the world).
 */

export interface IdleResourceOptions<T> {
  /** Label used in logs (e.g. `local-embeddings`). */
  name: string;
  /** Idle eviction TTL in ms. 0 (or negative) = never evict by idleness. */
  idleTtlMs: number;
  create: () => Promise<T>;
  destroy: (res: T) => Promise<void> | void;
  /** Test/telemetry hook, called after a successful destroy. */
  onEvict?: (reason: 'idle' | 'manual') => void;
}

export interface IdleResource<T> {
  /** Run `fn` holding the resource; creates it lazily; blocks eviction while running. */
  acquire<R>(fn: (res: T) => Promise<R> | R): Promise<R>;
  /** Manual eviction (shutdown). Waits for in-flight users; idempotent. */
  dispose(): Promise<void>;
  isLoaded(): boolean;
}

export function createIdleResource<T>(opts: IdleResourceOptions<T>): IdleResource<T> {
  let creating: Promise<T> | null = null;
  let resource: T | null = null;
  let active = 0;
  let generation = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposing: Promise<void> | null = null;
  const idleWaiters: Array<() => void> = [];

  const clearIdleTimer = (): void => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };

  const waitForIdle = (): Promise<void> =>
    active === 0 ? Promise.resolve() : new Promise((r) => { idleWaiters.push(r); });

  const notifyIfIdle = (): void => {
    if (active !== 0) return;
    while (idleWaiters.length > 0) idleWaiters.shift()!();
  };

  /** Detach current resource and destroy it. Safe to race with a fresh create. */
  const destroyNow = async (reason: 'idle' | 'manual'): Promise<void> => {
    const res = resource;
    resource = null;
    creating = null;
    generation++;
    clearIdleTimer();
    if (res === null) return;
    try {
      await opts.destroy(res);
      console.error(`[idle-disposer] ${opts.name}: evicted (${reason})`);
      opts.onEvict?.(reason);
    } catch (e) {
      console.warn(`[idle-disposer] ${opts.name}: destroy failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const armIdleTimer = (): void => {
    if (opts.idleTtlMs <= 0 || active !== 0 || resource === null) return;
    clearIdleTimer();
    const gen = generation;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (gen !== generation || active !== 0) return; // stale schedule or busy again
      void destroyNow('idle');
    }, opts.idleTtlMs);
    idleTimer.unref?.();
  };

  const getOrCreate = (): Promise<T> => {
    if (creating) return creating;
    // Definite-assignment: the closure only reads `attempt` after the first
    // await, by which point the assignment below has run.
    let attempt!: Promise<T>;
    attempt = (async () => {
      const res = await opts.create();
      if (creating === attempt) resource = res;
      return res;
    })();
    creating = attempt;
    // Do not memoize failures — reset so the next acquire retries.
    attempt.catch(() => {
      if (creating === attempt) { creating = null; resource = null; }
    });
    return attempt;
  };

  return {
    async acquire<R>(fn: (res: T) => Promise<R> | R): Promise<R> {
      while (disposing) await disposing;
      generation++;
      clearIdleTimer();
      active++;
      try {
        const res = await getOrCreate();
        return await fn(res);
      } finally {
        active--;
        notifyIfIdle();
        armIdleTimer();
      }
    },

    dispose(): Promise<void> {
      if (disposing) return disposing;
      disposing = (async () => {
        generation++;
        clearIdleTimer();
        const pending = creating;
        await waitForIdle();
        if (pending) {
          try { await pending; } catch { /* failed create — nothing to destroy */ }
        }
        await destroyNow('manual');
      })().finally(() => { disposing = null; });
      return disposing;
    },

    isLoaded(): boolean {
      return resource !== null;
    },
  };
}
