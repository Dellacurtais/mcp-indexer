import type { LLMReference } from '@ctx/shared/types.js';

/**
 * Enriches LLM-extracted symbol references with line numbers and snippets.
 * If the LLM omits line/snippet, scans the file content for the first
 * occurrence of `\b<symbol_name>\b` and uses that location. Ensures `line`
 * is rarely null.
 */
export function enrichReferencesWithLines(
  references: LLMReference[],
  fileContent: string,
): LLMReference[] {
  if (references.length === 0) return references;
  const lines = fileContent.split('\n');

  return references.map((ref) => {
    if (ref.line && ref.line > 0 && ref.line <= lines.length) {
      // LLM provided a line — verify by checking it actually contains the
      // symbol; if not, fall through to scan.
      const lineText = lines[ref.line - 1] ?? '';
      if (lineText.includes(ref.symbol_name)) {
        return { ...ref, snippet: ref.snippet ?? lineText.trim().slice(0, 200) };
      }
    }

    // Fallback: regex scan for first occurrence. The relocated line makes any
    // pre-existing col meaningless — recompute it from the match position.
    const escaped = ref.symbol_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (m) {
        return { ...ref, line: i + 1, col: m.index + 1, snippet: ref.snippet ?? lines[i].trim().slice(0, 200) };
      }
    }
    return ref; // No match found anywhere — leave as-is (line will be null).
  });
}

/**
 * Bounded parallel map. Each item runs `fn(item, index)`; up to `limit`
 * promises are in flight at once. Used by the indexer's per-file pipeline.
 */
export async function withConcurrency<T>(
  items: T[],
  fn: (item: T, index: number) => Promise<void>,
  limit: number,
): Promise<void> {
  let index = 0;
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const currentIndex = index++;
    const p = fn(item, currentIndex).then(() => { executing.delete(p); });
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}
