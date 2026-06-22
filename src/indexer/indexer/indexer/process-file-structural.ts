import { readFileSync, statSync } from 'node:fs';
import type { CodeIndexDB } from '@ctx/store/db.js';
import type { ScannedFile } from '@ctx/shared/types.js';
import type { TreeSitterResult } from '@ctx/indexer/indexer/tree-sitter/index.js';

import { enrichReferencesWithLines } from './enrich-references.js';
import { hashContent, countLines } from '../content-hash.js';

export interface ProcessFileStructuralResult {
  fileId: number;
  /** Tree-sitter handled the language (symbols/refs/deps are fresh). */
  supported: boolean;
  symbolCount: number;
}

/**
 * Per-file STRUCTURAL pipeline — the free half of `processFile`: tree-sitter
 * extraction + persistence, no LLM, no embeddings, no cost tracking.
 *
 * Invariants (the dumb→smart contract):
 *  - Persists via `upsertFileStructural` — semantic columns (summary/concepts/
 *    layer/semantic_hash) are never written, so a previous full-index's work
 *    survives and `semantic_hash != content_hash` marks it stale.
 *  - Never writes `structure_hash`/`structure_embedding` — those are the FULL
 *    pipeline's llm-skip baseline; advancing them here would make the next
 *    full run reuse a stale summary forever.
 *  - No `saveFileSnapshot` (snapshots carry run semantics).
 *  - Unsupported languages keep their existing symbols/deps untouched
 *    (stale-but-useful LLM output beats nothing).
 */
export async function processFileStructural(
  db: CodeIndexDB,
  projectId: number,
  file: ScannedFile,
  treeSitter: { extract: (filePath: string, content: string) => Promise<TreeSitterResult> },
): Promise<ProcessFileStructuralResult> {
  // Lazy content read, same drift handling as processFile: the file may have
  // changed between scan and process; `files.content_hash` must match what we
  // actually parsed.
  let content = file.content ?? '';
  let hash = file.hash;
  let sizeBytes = file.sizeBytes;
  let lineCount = file.lineCount;
  let mtimeMs = file.mtimeMs ?? null;
  if (!content && file.path) {
    content = readFileSync(file.path, 'utf-8');
    const freshHash = hashContent(content);
    if (freshHash !== hash) {
      hash = freshHash;
      sizeBytes = Buffer.byteLength(content, 'utf-8');
      lineCount = countLines(content);
      const st = statSync(file.path, { throwIfNoEntry: false });
      mtimeMs = st ? Math.trunc(st.mtimeMs) : null;
    }
  }

  const tsResult = await treeSitter.extract(file.relativePath, content);
  const supported = tsResult.supported;
  const symbols = supported ? tsResult.analysis.symbols ?? [] : [];

  const fileId = db.indexTransaction(projectId, () => {
    const { fileId: id } = db.upsertFileStructural(projectId, {
      path: file.relativePath,
      language: tsResult.language || 'unknown',
      size: sizeBytes,
      lineCount,
      contentHash: hash,
      mtimeMs,
      // Only overwrite the dependency columns when tree-sitter produced them;
      // for unsupported languages the previous (LLM) values stay.
      ...(supported
        ? {
            dependencies: tsResult.analysis.dependencies ?? [],
            internalDeps: tsResult.analysis.internal_deps ?? [],
            externalDeps: tsResult.analysis.external_deps ?? [],
          }
        : {}),
    });

    if (supported) {
      // Empty array still upserts — an edit that removed every symbol must
      // clear the stale ones (upsertSymbols is delete+insert per file).
      db.upsertSymbols(projectId, id, file.relativePath, symbols);
      db.upsertFileDependencies(
        projectId, id, file.relativePath,
        tsResult.analysis.internal_deps ?? [],
        tsResult.analysis.external_deps ?? [],
      );
      const references = tsResult.analysis.references ?? [];
      if (references.length > 0) {
        db.upsertSymbolReferences(projectId, id, file.relativePath, enrichReferencesWithLines(references, content));
      }
    }

    db.upsertFileContent(id, content, sizeBytes, projectId);
    return id;
  });

  return { fileId, supported, symbolCount: symbols.length };
}
