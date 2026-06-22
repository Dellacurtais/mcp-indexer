/**
 * Candidate-isolation cache wrapper for scorers.
 *
 * Inspired by the candidate-isolation attention mask in
 * `phoenix/grok.py:39-71`: each candidate's score depends ONLY on the
 * query, never on other candidates. This invariant makes scores
 * deterministic per (query, candidate) pair and therefore CACHEABLE.
 *
 * This wrapper takes an underlying scoring function and adds an in-process
 * cache keyed by (queryHash, candidateId). Hits return instantly; misses
 * call the underlying scorer.
 *
 * Why this matters: the same query+candidate combination can appear in
 * multiple pipeline runs (e.g. retry, multi-turn re-ranking). Caching
 * isolated scores cuts redundant LLM/embedding calls dramatically.
 */
import type { CacheStore } from '../traits.js';

export interface IsolatedScoreInput<C> {
  candidate: C;
  candidateId: string;
  /** Stable hash of the query relevant to this scorer's inputs. */
  queryHash: string;
}

export interface IsolatedScoreCacheOptions {
  /** Optional TTL in ms. Default: no TTL (relies on LRU eviction). */
  ttlMs?: number;
}

/**
 * Wrap a per-candidate scoring function with a (queryHash, candidateId) cache.
 *
 * Example:
 *
 * ```ts
 * const score = withCandidateIsolationCache(myCache, async ({ candidate, queryHash }) => {
 *   // compute the score — assume this call is expensive
 *   return await embeddingClient.score(queryHash, candidate);
 * });
 * const scores = await Promise.all(candidates.map(c =>
 *   score({ candidate: c, candidateId: c.candidateId, queryHash: 'h1' })
 * ));
 * ```
 */
export function withCandidateIsolationCache<C>(
  cache: CacheStore<string, number>,
  scoreFn: (input: IsolatedScoreInput<C>) => Promise<number>,
  options: IsolatedScoreCacheOptions = {},
): (input: IsolatedScoreInput<C>) => Promise<number> {
  return async (input) => {
    const key = `${input.queryHash}::${input.candidateId}`;
    const cached = await cache.get(key);
    if (cached !== undefined) return cached;
    const score = await scoreFn(input);
    await cache.set(key, score, options.ttlMs);
    return score;
  };
}
