/**
 * Tree-sitter dispatch — in-process only.
 *
 * The upstream IDE ran extraction on a worker pool (CPU-bound, kept off the
 * main thread). code-context vendors only the in-process `TreeSitterExtractor`,
 * so dispatch is a thin wrapper around one extractor instance per dispatch
 * object. This is the same `TreeSitterExtractor` the upstream used as its
 * worker-unavailable fallback.
 */
import { TreeSitterExtractor, type TreeSitterResult } from '@ctx/indexer/indexer/tree-sitter/index.js';

export interface TreeSitterDispatch {
  extract(filePath: string, content: string): Promise<TreeSitterResult>;
  dispose(): void;
}

/** Kept for API compatibility with call sites that reset a (now absent) fallback. */
export function resetTreeSitterDispatchFallback(): void {
  /* no worker pool to reset — in-process extraction only */
}

export function buildTreeSitterDispatch(): TreeSitterDispatch {
  const extractor = new TreeSitterExtractor();
  return {
    extract: (filePath, content) => extractor.extract(filePath, content),
    dispose: () => extractor.dispose(),
  };
}
