/**
 * Sliding-window text chunking, shared by the code-body embedder
 * (`embedding-candidates.ts`) and the snapshot embedder (`snapshots.ts`).
 *
 * Both used to truncate at a fixed char cap (2500 for symbol bodies, 2000 for
 * snapshots), silently dropping the tail of large functions / long notes from
 * the vector index. Splitting into overlapping windows preserves recall over
 * the whole text while keeping each embed input bounded.
 */

export interface SlidingWindowOptions {
  /** Max characters per window (keeps each embed input bounded). */
  windowChars: number;
  /** Characters shared between consecutive windows so matches near a
   *  boundary aren't split across two chunks. */
  overlapChars: number;
  /** Hard cap on window count. Bounds embedding cost AND the number of
   *  deterministic vector ids a single entity can spawn (orphan budget). */
  maxChunks: number;
}

/**
 * Split `text` into overlapping windows.
 *
 * - A text that fits in one window returns `[text]` — callers can treat
 *   `length === 1` as the non-chunked case (byte-identical to the old
 *   truncate path when the text was already under the cap).
 * - Windows step by `windowChars - overlapChars`.
 * - At most `maxChunks` windows are returned; content past the last window's
 *   end is dropped (still far more coverage than a single truncated chunk).
 */
export function slidingWindows(text: string, opts: SlidingWindowOptions): string[] {
  const windowChars = Math.max(1, Math.floor(opts.windowChars));
  const maxChunks = Math.max(1, Math.floor(opts.maxChunks));
  if (text.length <= windowChars || maxChunks === 1) {
    return [text.slice(0, windowChars)];
  }
  const overlap = Math.min(Math.max(0, Math.floor(opts.overlapChars)), windowChars - 1);
  const step = windowChars - overlap;
  const out: string[] = [];
  for (let start = 0; start < text.length && out.length < maxChunks; start += step) {
    out.push(text.slice(start, start + windowChars));
  }
  return out;
}
