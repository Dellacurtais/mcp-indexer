/**
 * Indexer event bus (I3 — Sprint 1).
 *
 * Lightweight pub/sub for "the indexer just touched files in project X".
 * Loose analog of xai-org/x-algorithm's `home-mixer/side_effects/*` —
 * fire-and-forget observers that run after the main response is built.
 *
 * **Why a custom event type and not an EventEmitter?** We want:
 *   - Type safety on the event shape
 *   - Listeners that swallow errors (one bad listener can't break indexing)
 *   - No leaking of EventEmitter's `on`/`once`/`removeListener` surface
 *     into the public API of `IndexAgent`
 *
 * Currently a single event type — `files_updated` — fires after each
 * `indexProject()` completes. Listeners typically:
 *   - Invalidate downstream caches (HybridSearch query cache — see
 *     `cache-invalidator.ts`)
 *   - Publish a webhook for external dashboards
 *   - Update an in-memory project-state counter for the UI
 *
 * Listeners are stored on the IndexAgent instance and fired sequentially
 * after the run completes. Listener throws are caught and logged; they
 * never affect the indexer's return value or other listeners.
 */

export interface IndexerFilesUpdatedEvent {
  /** The project that was just (re-)indexed. */
  projectId: number;
  projectName: string;
  /** Run identifier from `coder_index_runs` for cross-referencing telemetry. */
  runId: number;
  /** Count of files added or re-embedded in this run. */
  indexedCount: number;
  /** Count of files removed from the index (deleted from disk). */
  removedCount: number;
  /**
   * Matches IndexAgent's run status: 'failed' when errors exceeded half the
   * files, 'completed_with_errors' when some files or the embedding pipeline
   * failed, 'completed' otherwise.
   */
  status: 'completed' | 'completed_with_errors' | 'failed';
  /** Wall-clock ms when the run finished. */
  finishedAtMs: number;
}

/**
 * A listener registered with `IndexAgent.onFilesUpdated()`. May be sync or
 * async; the indexer awaits async listeners but never blocks on errors.
 */
export type IndexerFilesUpdatedListener = (
  event: IndexerFilesUpdatedEvent,
) => void | Promise<void>;
