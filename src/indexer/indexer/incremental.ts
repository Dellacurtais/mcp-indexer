/**
 * Incremental in-session re-indexing.
 *
 * Runs the tree-sitter symbol extractor against a single file's current
 * contents and upserts the result into the symbol DB. Used by the coder
 * runner to keep `mcp__find_references`, `mcp__grep_code`, `mcp__get_symbol_body`
 * and friends fresh after the agent edits a file — without paying the cost
 * of the full LLM-driven indexer pipeline.
 *
 * Scope:
 *  - Only refreshes symbols for files that already have a row in `files`.
 *    New files (never indexed) are skipped — full indexing is the right path
 *    there because metadata fields (summary, concepts, layer, …) require the
 *    LLM and don't have sane tree-sitter defaults.
 *  - Languages without a tree-sitter grammar return false (no-op).
 *  - Errors are swallowed and logged. This is a best-effort cache refresh,
 *    never a correctness gate.
 */
import { extname } from 'node:path';
import type { CodeIndexDB } from '@ctx/store/db.js';
import { createIdleResource } from '@ctx/shared/utils/idle-disposer.js';
import { TreeSitterExtractor } from '@ctx/indexer/indexer/tree-sitter/extractor.js';
import { getGrammarForExtension, initTreeSitter, clearLanguageCache } from '@ctx/indexer/indexer/tree-sitter/languages.js';

/**
 * Idle TTL for the shared extractor. The coder runner calls this after
 * every edit, so usage comes in bursts; five quiet minutes means the agent
 * stopped and the parsers can go. Re-creation is cheap (~10-50ms/grammar,
 * wasm in page cache). Honest caveat: disposing does NOT shrink RSS on the
 * main process (emscripten heap never returns memory and `Language` has no
 * `delete()` in web-tree-sitter 0.24.7) — this is a growth ceiling and a
 * clean shutdown path; the real tree-sitter RAM return is the worker pool's
 * idle shutdown. Default in code; `MCP_TS_IDLE_TTL_MS` overrides, 0 = off.
 */
const DEFAULT_TS_IDLE_TTL_MS = 5 * 60_000;

const resolveTsIdleTtlMs = (): number => {
  const raw = Number(process.env.MCP_TS_IDLE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_TS_IDLE_TTL_MS;
};

const extractorLease = createIdleResource<TreeSitterExtractor>({
  name: 'tree-sitter-shared',
  idleTtlMs: resolveTsIdleTtlMs(),
  create: async () => {
    await initTreeSitter();
    return new TreeSitterExtractor();
  },
  destroy: (ex) => {
    ex.dispose();
    clearLanguageCache();
  },
});

/** Wired into process shutdown via `disposeIndexerProcessResources()`. */
export async function disposeSharedExtractor(): Promise<void> {
  return extractorLease.dispose();
}

/**
 * Public helper: run tree-sitter on `(relPath, content)` and return the
 * extracted symbols (or null when the language is unsupported / extraction
 * fails). Used by tools that need on-the-fly structural data without
 * touching the symbol DB — e.g. `get_file_skeleton` falling back when the
 * project is not indexed.
 */
export async function treeSitterSymbols(
  relPath: string,
  content: string,
): Promise<{ symbols: Array<{ name: string; kind: string; signature: string; line: number; end_line?: number; parent: string | null }> } | null> {
  const ext = extname(relPath).replace(/^\./, '').toLowerCase();
  if (!getGrammarForExtension(ext)) return null;
  try {
    const result = await extractorLease.acquire((ex) => ex.extract(relPath, content));
    if (!result.supported || !result.analysis.symbols) return null;
    return {
      symbols: result.analysis.symbols.map((s) => ({
        name: s.name,
        kind: s.kind,
        signature: s.signature,
        line: s.line ?? 0,
        end_line: (s as { end_line?: number }).end_line,
        parent: s.parent ?? null,
      })),
    };
  } catch {
    return null;
  }
}

/**
 * Re-extract symbols for one file and upsert them. Returns true when the
 * symbol table was updated, false otherwise (unsupported language, unknown
 * file, extraction error). Never throws.
 */
export async function indexFileNow(
  db: CodeIndexDB,
  projectId: number,
  relPath: string,
  content: string,
): Promise<boolean> {
  try {
    const ext = extname(relPath).replace(/^\./, '').toLowerCase();
    if (!getGrammarForExtension(ext)) return false;

    const fileRow = db.getFile(projectId, relPath);
    if (!fileRow) return false;

    const result = await extractorLease.acquire((ex) => ex.extract(relPath, content));
    if (!result.supported || !result.analysis.symbols) return false;

    db.upsertSymbols(projectId, fileRow.id, relPath, result.analysis.symbols);
    return true;
  } catch (e) {
    console.warn(`[incremental-index] ${relPath}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
