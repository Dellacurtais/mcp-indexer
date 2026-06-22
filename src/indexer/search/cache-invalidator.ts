/**
 * HybridSearchCacheInvalidator (I3 — Sprint 1).
 *
 * Listener that clears the HybridSearch query LRU when the indexer
 * publishes a `files_updated` event. Without this, the cache silently
 * serves stale results after a re-index — the bug the plan called out.
 *
 * **Scope**: today we clear the ENTIRE query cache on any indexer
 * completion. Future enhancement could clear only entries whose query
 * relates to the changed files, but that requires reverse-mapping
 * `query → fileId`, which the existing cache shape (`projectId:query:
 * mode:type:limit`) doesn't carry. A coarse clear is safe (correct
 * results, cost = next query is a miss) and matches the plan's
 * "manual `invalidateCache()` mais fallback" approach.
 *
 * **Wiring** (deps.ts):
 *   const invalidator = makeHybridSearchCacheInvalidator(hybridSearch);
 *   indexAgent.onFilesUpdated(invalidator);
 *
 * Backward compat: this file only adds; nothing in HybridSearch or
 * IndexAgent depends on it. Default behavior unchanged.
 */
import type { HybridSearch } from './hybrid.js';
import type {
  IndexerFilesUpdatedEvent,
  IndexerFilesUpdatedListener,
} from '@ctx/indexer/indexer/indexer-events.js';

/**
 * Build a listener that calls `hybridSearch.invalidateCache()` after a
 * successful (or failed) re-index. Skipping on `removedCount === 0 &&
 * indexedCount === 0` would be tempting, but even a "no-op" re-index can
 * affect search results (provider/model migration, embedding upgrade) —
 * the safest default is to always invalidate.
 */
export function makeHybridSearchCacheInvalidator(
  hybridSearch: HybridSearch,
): IndexerFilesUpdatedListener {
  return (event: IndexerFilesUpdatedEvent): void => {
    // Only invalidate when something actually touched the index. A truly
    // empty `removedCount + indexedCount === 0` run produces no change
    // — but we still clear to be safe against edge cases (corruption,
    // tombstones, embedding-config migrations).
    void event;
    hybridSearch.invalidateCache();
  };
}
