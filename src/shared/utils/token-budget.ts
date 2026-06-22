/**
 * Token-budget helpers.
 *
 * These are approximations, not a real tokenizer. For the workloads this
 * MCP handles (code and markdown), the chars/4 heuristic is within ~20%
 * of real tokenizers (cl100k_base, o200k_base) for Latin-script code
 * — good enough for budgeting, not for billing.
 *
 * All helpers are pure and free of DB access, so they can be used by
 * tool handlers and tests without setup.
 */

/** Average characters-per-token for typical source code. */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the number of tokens in a string. Uses a chars/4 heuristic —
 * fast, deterministic, no dependencies. Expected error: ~20%.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncate a string so it fits within a token budget. When truncation
 * happens, a suffix is appended announcing the cut. Passing `undefined`
 * or `<=0` for `maxTokens` is a no-op (returns input unchanged).
 */
export function truncateToTokens(text: string, maxTokens?: number): string {
  if (!maxTokens || maxTokens <= 0) return text;
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n... [truncated to ~${maxTokens} tokens]`;
}

/**
 * Truncate a list of items by accumulated estimated token count. Returns
 * the items that fit plus a flag indicating whether truncation occurred.
 *
 * Useful when building compact lists where each item has a known
 * formatted representation (e.g. one line per symbol).
 *
 * Example:
 *   const { kept, truncated, total } = truncateItemsByTokens(
 *     symbols,
 *     (s) => `${s.kind} ${s.name}`,
 *     maxTokens,
 *   );
 */
export function truncateItemsByTokens<T>(
  items: T[],
  format: (item: T) => string,
  maxTokens: number
): { kept: T[]; truncated: boolean; total: number } {
  if (maxTokens <= 0) {
    return { kept: items, truncated: false, total: items.length };
  }
  const budget = maxTokens * CHARS_PER_TOKEN;
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const formatted = format(item);
    const size = formatted.length + 1; // +1 for newline
    if (used + size > budget) {
      return { kept, truncated: true, total: items.length };
    }
    kept.push(item);
    used += size;
  }
  return { kept, truncated: false, total: items.length };
}

/**
 * Cap a list by count, returning a standard envelope that callers can
 * serialize into tool responses. Keeps the first `maxCount` items.
 */
export function capList<T>(
  items: T[],
  maxCount: number
): { shown: T[]; total: number; truncated: boolean } {
  if (items.length <= maxCount) {
    return { shown: items, total: items.length, truncated: false };
  }
  return { shown: items.slice(0, maxCount), total: items.length, truncated: true };
}
