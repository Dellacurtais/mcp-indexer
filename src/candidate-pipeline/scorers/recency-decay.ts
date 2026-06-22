/**
 * Exponential-decay scoring by age.
 *
 * Useful for "recency" signals: messages, events, file reads. The half-life
 * controls how fast the score halves — at `t = halfLifeMs`, score is 0.5.
 *
 *   decay(t) = 2^(-t / halfLifeMs)
 *
 * Combined with `weighted-sum`, gives recency as one signal alongside
 * task-affinity, decision-markers, etc. — same pattern as the Twitter
 * weighted scorer combining favorite + reply + retweet + dwell signals.
 */

export interface RecencyDecayOptions {
  /** Time in ms at which the score equals 0.5. */
  halfLifeMs: number;
  /** Reference timestamp (defaults to now). */
  now?: number;
  /** Floor — never return less than this. Default 0. */
  floor?: number;
  /** Ceiling — never return more than this. Default 1. */
  ceiling?: number;
}

/**
 * Compute the decay factor for an item with the given creation timestamp.
 * Returns a value in [floor, ceiling].
 */
export function recencyDecay(createdAtMs: number, options: RecencyDecayOptions): number {
  const now = options.now ?? Date.now();
  const floor = options.floor ?? 0;
  const ceiling = options.ceiling ?? 1;
  const ageMs = Math.max(0, now - createdAtMs);
  const factor = Math.pow(2, -ageMs / options.halfLifeMs);
  if (factor < floor) return floor;
  if (factor > ceiling) return ceiling;
  return factor;
}

/** Apply decay to a batch — useful for one-shot scoring of long lists. */
export function batchRecencyDecay(
  items: ReadonlyArray<{ createdAtMs: number }>,
  options: RecencyDecayOptions,
): number[] {
  const now = options.now ?? Date.now();
  return items.map((it) => recencyDecay(it.createdAtMs, { ...options, now }));
}
