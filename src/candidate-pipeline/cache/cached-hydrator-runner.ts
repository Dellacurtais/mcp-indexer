/**
 * Helper that implements the cache-hit/miss routing for `CachedHydrator`.
 *
 * Mirrors the blanket impl in `candidate-pipeline/hydrator.rs:128-184`:
 * for each candidate, look up the cache; misses go to a single
 * `hydrateFromClient(...)` call; results are written back to the cache;
 * outputs preserve order.
 *
 * Each concrete CachedHydrator subclass calls this helper from its
 * `hydrate(...)` to get the routing for free, while still doing per-
 * candidate `update(...)` themselves.
 */
import type { CachedHydrator } from '../traits.js';
import type { CandidateResult, PipelineCandidate, PipelineQuery } from '../types.js';

export interface CacheHydrationStats {
  hits: number;
  misses: number;
}

export async function runCachedHydrator<
  Q extends PipelineQuery,
  C extends PipelineCandidate,
  K,
  V,
>(
  hydrator: CachedHydrator<Q, C, K, V>,
  query: Q,
  candidates: readonly C[],
): Promise<{ results: Array<CandidateResult<C>>; stats: CacheHydrationStats }> {
  const results: Array<CandidateResult<C>> = new Array(candidates.length);
  const missingIndexes: number[] = [];
  const missingCandidates: C[] = [];
  const stats: CacheHydrationStats = { hits: 0, misses: 0 };

  for (let i = 0; i < candidates.length; i++) {
    const key = hydrator.cacheKey(candidates[i]);
    const cached = await hydrator.cacheStore.get(key);
    if (cached !== undefined) {
      results[i] = { ok: true, candidate: hydrator.hydrateFromCache(cached as V) };
      stats.hits++;
    } else {
      missingIndexes.push(i);
      missingCandidates.push(candidates[i]);
      stats.misses++;
    }
  }

  if (missingCandidates.length > 0) {
    const clientResults = await hydrator.hydrateFromClient(query, missingCandidates);
    if (clientResults.length !== missingCandidates.length) {
      throw new Error(
        `CachedHydrator '${hydrator.name}' returned ${clientResults.length} results for ${missingCandidates.length} candidates`,
      );
    }
    for (let j = 0; j < clientResults.length; j++) {
      const idx = missingIndexes[j];
      const cr = clientResults[j];
      results[idx] = cr;
      if (cr.ok) {
        const key = hydrator.cacheKey(missingCandidates[j]);
        const value = hydrator.cacheValue(cr.candidate);
        await hydrator.cacheStore.set(key, value);
      }
    }
  }

  return { results, stats };
}
