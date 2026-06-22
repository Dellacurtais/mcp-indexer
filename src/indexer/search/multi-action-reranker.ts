/**
 * I5 — Multi-action reranker (Sprint 3).
 *
 * Direct port of the multi-action prediction pattern from Phoenix
 * (xai-org/x-algorithm): instead of producing ONE relevance score per
 * (query, document), the reranker predicts SEVERAL signals at once
 * — relevance, freshness, scope_match, code_proximity, etc. — and a
 * weighted fusion combines them into the final score.
 *
 * **Why multi-action**:
 *   - One LLM call producing N signals is cheaper than N calls each
 *     producing one signal.
 *   - Different consumers can WEIGHT signals differently (e.g. the
 *     dashboard search wants high relevance + freshness; the agent
 *     wants high relevance + scope_match).
 *   - Per-action ablation is trivial — drop a signal by setting its
 *     weight to 0.
 *
 * **Status**: Sprint 3 ships the INTERFACE + a `WeightedActionFusion`
 * helper + a `NullMultiActionReranker` (returns one action 'relevance'
 * with the original score → backward-compatible). Real LLM-backed
 * impls (Cohere multi-aspect, Cloudflare BGE reranker fine-tuned for
 * multiple actions) live behind shadow A/B until the user enables
 * `MCP_PIPELINES_MULTI_ACTION_RERANKER=1` in follow-up.
 *
 * **Backward compat**: no existing code path uses
 * `MultiActionRerankerService`. The legacy `RerankerService` interface
 * keeps working untouched. This module is purely additive.
 */
import type { RerankCandidate, RerankResult, RerankerService } from './reranker.js';

/**
 * Standard action vocabulary. Each action is a sub-signal the reranker
 * predicts. Implementations may produce a subset — missing keys are
 * treated as 0 by the fusion helper.
 */
export type RerankerAction =
  | 'relevance' // Default: query↔doc semantic match
  | 'freshness' // Recently modified > stale (per the indexer's file mtime)
  | 'scope_match' // Doc lives in the same package/module as the query target
  | 'code_proximity' // Symbol declarations vs prose docs — boost when query is identifier-shaped
  | 'authority'; // Official docs > blog posts (for docs search)

export interface MultiActionRerankResult {
  /** Same candidate id the caller passed in. */
  id: string;
  /** Per-action scores in [0, 1]. Missing actions are treated as 0. */
  actions: Partial<Record<RerankerAction, number>>;
  /** Original RRF score from the caller — preserved for tie-breaking. */
  originalScore: number;
}

export interface MultiActionRerankerService {
  readonly name: string;
  /**
   * Rerank candidates and return per-candidate action scores. The
   * caller fuses them via `weightedActionFusion(...)` (or a custom
   * weighting) to produce the final ordering.
   *
   * Implementations MUST return at most `topK` results, ordered by
   * the implementation's own preferred metric — typically `relevance`
   * — so callers that ignore the multi-action surface and just take
   * the order still get a sensible result.
   */
  rerank(
    query: string,
    candidates: RerankCandidate[],
    topK?: number,
  ): Promise<MultiActionRerankResult[]>;
}

// ─── Default null implementation (backward compat) ───────────────────

/**
 * Passthrough multi-action reranker: returns one action 'relevance'
 * equal to the original score. Used when no real multi-action service
 * is configured; the fused score then equals the input score
 * (modulo weights) — bit-identical behavior to "no reranker".
 */
export class NullMultiActionReranker implements MultiActionRerankerService {
  readonly name = 'null_multi_action';
  async rerank(
    _query: string,
    candidates: RerankCandidate[],
    topK = 10,
  ): Promise<MultiActionRerankResult[]> {
    return candidates.slice(0, topK).map((c) => ({
      id: c.id,
      actions: { relevance: c.originalScore },
      originalScore: c.originalScore,
    }));
  }
}

// ─── Adapter: single-action → multi-action ────────────────────────────

/**
 * Wraps an existing single-action `RerankerService` (e.g. CohereReranker,
 * CloudflareReranker) so it satisfies the multi-action interface.
 * Useful for shadow A/B where the new path uses the multi-action
 * machinery but the actual model produces only 'relevance'.
 */
export class SingleActionAdapter implements MultiActionRerankerService {
  readonly name: string;
  constructor(private inner: RerankerService) {
    this.name = `single_to_multi(${inner.name})`;
  }
  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topK?: number,
  ): Promise<MultiActionRerankResult[]> {
    const results = await this.inner.rerank(query, candidates, topK);
    return results.map((r: RerankResult) => ({
      id: r.id,
      actions: { relevance: r.score },
      originalScore: r.originalScore,
    }));
  }
}

// ─── Fusion ───────────────────────────────────────────────────────────

export type ActionWeights = Partial<Record<RerankerAction, number>>;

/**
 * Default weights — relevance dominates; the rest are small boosts.
 * Same shape as `home-mixer/scorers/weighted_scorer.rs:DEFAULT_WEIGHTS`.
 */
export const DEFAULT_ACTION_WEIGHTS: Readonly<ActionWeights> = Object.freeze({
  relevance: 1.0,
  scope_match: 0.4,
  freshness: 0.2,
  code_proximity: 0.3,
  authority: 0.3,
});

export interface WeightedActionResult {
  id: string;
  score: number;
  /** Per-action contributions for diagnostic / shadow comparison. */
  contributions: Partial<Record<RerankerAction, number>>;
  originalScore: number;
}

/**
 * Apply the weighted-sum fusion: `score = Σ (weight[a] × action[a])`.
 *
 * Missing actions contribute 0; missing weights contribute 0; both
 * present and present action × weight contribute their product. Result
 * is sorted by `score` descending (matches `RerankerService.rerank`
 * contract).
 *
 * Diagnostics: each result carries the per-action contribution so a
 * shadow runner can see which signal drove the score — useful for
 * tuning weights via offline analysis.
 */
export function weightedActionFusion(
  results: ReadonlyArray<MultiActionRerankResult>,
  weights: ActionWeights = DEFAULT_ACTION_WEIGHTS,
): WeightedActionResult[] {
  const fused: WeightedActionResult[] = results.map((r) => {
    let score = 0;
    const contributions: Partial<Record<RerankerAction, number>> = {};
    for (const [action, value] of Object.entries(r.actions) as Array<[RerankerAction, number]>) {
      const w = weights[action] ?? 0;
      if (!w) continue;
      const contribution = w * value;
      contributions[action] = contribution;
      score += contribution;
    }
    return { id: r.id, score, contributions, originalScore: r.originalScore };
  });
  fused.sort((a, b) => b.score - a.score);
  return fused;
}

/**
 * Convenience: project a `WeightedActionResult[]` back to the legacy
 * `RerankResult[]` shape so it can be dropped into existing code paths
 * that expect the single-score interface.
 */
export function toRerankResults(fused: ReadonlyArray<WeightedActionResult>): RerankResult[] {
  return fused.map((r) => ({ id: r.id, score: r.score, originalScore: r.originalScore }));
}
