/**
 * Process-level disposal of indexer module singletons. In code-context this is
 * just the shared in-process tree-sitter extractor (the dbWriter / index-job
 * worker pools were IDE-only and are not vendored). Idempotent and non-throwing
 * — shutdown must never be aborted by a failing disposer.
 */
import { disposeSharedExtractor } from '@ctx/indexer/indexer/incremental.js';

export async function disposeIndexerProcessResources(): Promise<void> {
  try {
    await disposeSharedExtractor();
  } catch (e) {
    console.warn(
      `[indexer] dispose sharedExtractor failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
