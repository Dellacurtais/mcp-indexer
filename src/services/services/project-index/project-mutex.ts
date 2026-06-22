/**
 * Per-key async mutex as a promise chain — serializes the structural run,
 * the dirty-queue drain and the manual full index for one project while
 * different projects proceed in parallel. FIFO by construction (each waiter
 * chains onto the previous tail).
 */
export class KeyedMutex<K = number> {
  private tails = new Map<K, Promise<unknown>>();

  /** True while something holds (or waits for) the key's lock. */
  isBusy(key: K): boolean {
    return this.tails.has(key);
  }

  async withLock<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // The new tail settles when fn settles — errors propagate to OUR caller
    // but must not poison the chain for the next waiter.
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => {
      // Clear only if we're still the tail (no newer waiter chained on).
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }
}
