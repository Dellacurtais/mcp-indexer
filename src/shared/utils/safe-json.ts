/**
 * Parse a JSON string that is expected to hold an array. Returns `fallback`
 * on null/undefined/corrupt/non-array input instead of throwing, so one bad
 * DB text row (concepts, notes, dependencies) can't kill a whole pipeline
 * that reads thousands of them (e.g. the embeddings retry job).
 */
export function safeJsonArray<T = unknown>(raw: string | null | undefined, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}
