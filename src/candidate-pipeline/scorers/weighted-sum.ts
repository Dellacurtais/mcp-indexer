/**
 * Weighted-sum scoring — combines multiple feature signals into a single
 * score with positive and negative weights.
 *
 * Translated from `home-mixer/weighted_scorer.rs:44-70` (xai-org/x-algorithm).
 * The formula:
 *
 *   combined = Σ weight_i × feature_i
 *   if combined < 0:
 *     normalized = (combined + NEG_W_SUM) / W_SUM × NEG_OFFSET
 *   else:
 *     normalized = combined + NEG_OFFSET
 *
 * Where `NEG_W_SUM` is the sum of absolute values of negative weights and
 * `W_SUM` is the sum of all weights' absolute values. The normalization
 * keeps negative-only candidates from collapsing to identical scores while
 * still ordering them by relative magnitude.
 */

export interface WeightedSumSignal {
  /** Stable identifier — used to inspect contribution per signal. */
  name: string;
  /** Raw value of this signal for the candidate (typically in [0, 1]). */
  value: number;
  /** Signed weight. Positive amplifies, negative dampens. */
  weight: number;
}

export interface WeightedSumOptions {
  /**
   * Constant added to the normalized score so non-negative scores remain
   * positive. Default 1.0 — keeps the output strictly positive when all
   * signals are positive. Matches `NEGATIVE_SCORES_OFFSET` in
   * `weighted_scorer.rs`.
   */
  negativeScoresOffset?: number;
}

export interface WeightedSumResult {
  /** Final normalized score. */
  score: number;
  /** Pre-normalization sum (useful for debugging). */
  combined: number;
  /** Per-signal contribution: weight × value. */
  contributions: Array<{ name: string; weight: number; value: number; contribution: number }>;
}

/**
 * Apply a single signal: returns `weight × value`, with sentinel handling
 * for non-finite inputs (treated as 0 contribution).
 */
function apply(value: number, weight: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(weight)) return 0;
  return value * weight;
}

export function weightedSum(
  signals: ReadonlyArray<WeightedSumSignal>,
  options: WeightedSumOptions = {},
): WeightedSumResult {
  const offset = options.negativeScoresOffset ?? 1.0;
  let combined = 0;
  let negSum = 0;
  let totalAbs = 0;
  const contributions: WeightedSumResult['contributions'] = [];

  for (const s of signals) {
    const c = apply(s.value, s.weight);
    combined += c;
    if (s.weight < 0) negSum += Math.abs(s.weight);
    totalAbs += Math.abs(s.weight);
    contributions.push({ name: s.name, weight: s.weight, value: s.value, contribution: c });
  }

  let normalized: number;
  if (combined < 0) {
    if (totalAbs === 0) {
      normalized = offset;
    } else {
      normalized = ((combined + negSum) / totalAbs) * offset;
    }
  } else {
    normalized = combined + offset;
  }

  return { score: normalized, combined, contributions };
}
