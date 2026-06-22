/**
 * Run an async `mapper` over `items` with a bounded number of in-flight
 * calls, returning results in INPUT order as `PromiseSettledResult`s.
 *
 * This is `Promise.allSettled(items.map(mapper))` with a concurrency cap —
 * a drop-in for callers that fan out to a rate-limited backend and must
 * not fire every request at once (e.g. the 5 quality classifiers sharing
 * one provider quota). Never throws: a mapper rejection becomes a
 * `{ status: 'rejected', reason }` entry, just like `allSettled`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}
