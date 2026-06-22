/**
 * Frequency-boost scoring — amplifies score of candidates referenced often
 * in a sliding window of recent events.
 *
 * Used by ToolSelection: tools called in the last N turns get a boost in
 * the next turn's tool-selection pipeline, so the model doesn't have to
 * "re-discover" tools it's already using.
 */

export interface FrequencyBoostOptions {
  /** Window in ms — only events within this window contribute. */
  windowMs: number;
  /** Reference timestamp; defaults to now. */
  now?: number;
  /** Maximum boost when an item dominates the window. Default 1.0. */
  maxBoost?: number;
  /** Saturation count — at this many occurrences, boost reaches maxBoost. Default 5. */
  saturationCount?: number;
}

/**
 * Compute a boost factor for a single candidate based on past references.
 * Returns a value in [0, maxBoost].
 */
export function frequencyBoost(
  candidateId: string,
  events: ReadonlyArray<{ candidateId: string; timestampMs: number }>,
  options: FrequencyBoostOptions,
): number {
  const now = options.now ?? Date.now();
  const cutoff = now - options.windowMs;
  const max = options.maxBoost ?? 1.0;
  const sat = options.saturationCount ?? 5;
  let count = 0;
  for (const e of events) {
    if (e.candidateId === candidateId && e.timestampMs >= cutoff) {
      count++;
    }
  }
  if (count === 0) return 0;
  if (count >= sat) return max;
  return max * (count / sat);
}

/** Batch variant — typical when scoring many candidates against the same event list. */
export function batchFrequencyBoost(
  candidateIds: ReadonlyArray<string>,
  events: ReadonlyArray<{ candidateId: string; timestampMs: number }>,
  options: FrequencyBoostOptions,
): number[] {
  const now = options.now ?? Date.now();
  const cutoff = now - options.windowMs;
  const max = options.maxBoost ?? 1.0;
  const sat = options.saturationCount ?? 5;

  // Build a count map once.
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.timestampMs >= cutoff) {
      counts.set(e.candidateId, (counts.get(e.candidateId) ?? 0) + 1);
    }
  }

  return candidateIds.map((id) => {
    const c = counts.get(id) ?? 0;
    if (c === 0) return 0;
    if (c >= sat) return max;
    return max * (c / sat);
  });
}
