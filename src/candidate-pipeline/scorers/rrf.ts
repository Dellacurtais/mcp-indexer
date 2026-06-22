/**
 * Reciprocal Rank Fusion — combines multiple ranked lists into one.
 *
 * Extracted verbatim from `packages/indexer/src/search/hybrid.ts:342-382`
 * (`rrfMerge`). The semantics are preserved: each list contributes a per-rank
 * score `1 / (K + rank + 1)` and identical candidates have their scores
 * summed.
 *
 * Why a free function (not a Scorer trait): callers that already have
 * pre-ranked lists from multiple sources use this as a merge step before
 * feeding into the framework. The framework's `Scorer` operates on a
 * single candidate set; RRF operates on N candidate sets.
 *
 * For a Scorer-style usage where the framework already has a single ranked
 * set, see `recency-decay.ts` or `weighted-sum.ts`.
 */

export const RRF_DEFAULT_K = 60;

export interface Rankable {
  /** Stable identity used to detect duplicates across lists. */
  candidateId: string;
}

export interface RankedSource<T extends Rankable> {
  /** Optional name for diagnostics — e.g. 'fts' / 'vector'. */
  name?: string;
  items: T[];
}

export interface RrfMergeOptions {
  /** RRF constant K — defaults to 60 (Cormack et al). */
  k?: number;
  /** Cap on output length. Defaults to no cap. */
  limit?: number;
}

/**
 * Merge N ranked lists via Reciprocal Rank Fusion. The output preserves the
 * first occurrence of each candidate (so per-source metadata isn't lost) and
 * attaches the fused score under `rrfScore`.
 */
export function rrfMerge<T extends Rankable>(
  sources: ReadonlyArray<RankedSource<T>>,
  options: RrfMergeOptions = {},
): Array<T & { rrfScore: number }> {
  const k = options.k ?? RRF_DEFAULT_K;
  const scoreMap = new Map<string, T & { rrfScore: number }>();

  for (const src of sources) {
    for (let rank = 0; rank < src.items.length; rank++) {
      const item = src.items[rank];
      const score = 1 / (k + rank + 1);
      const existing = scoreMap.get(item.candidateId);
      if (existing) {
        existing.rrfScore += score;
      } else {
        scoreMap.set(item.candidateId, Object.assign({}, item, { rrfScore: score }));
      }
    }
  }

  const merged = Array.from(scoreMap.values()).sort((a, b) => b.rrfScore - a.rrfScore);
  return options.limit != null ? merged.slice(0, options.limit) : merged;
}
