/**
 * Shared contracts for the structural auto-index service ("dumb mode").
 * The executor abstraction is the worker seam: in-process by default,
 * upgraded to the dedicated indexer worker_thread by the app boots.
 */

export type ProjectIndexPhase =
  | 'none'
  | 'scanning'
  | 'structural_indexing'
  | 'structural_ready'
  | 'semantic_indexing'
  | 'semantic_ready'
  | 'too_large'
  | 'error';

/**
 * The single in-flight index pass for a project. Passes are serialized by the
 * per-project mutex, so there is at most ONE at a time — `kind` lets the UI
 * label/scope it ("Indexing symbols 40/120" vs "Embedding 12/80") and gives
 * each its own monotonic bar. Lives in the main-process status store, so it
 * survives a renderer remount (the fix for "leave the screen, lose progress").
 */
export interface ActiveIndexRun {
  kind: 'structural' | 'semantic' | 'embeddings';
  current: number;
  total: number;
  currentFile?: string;
  /** epoch ms — for an elapsed-time readout when the UI re-hydrates. */
  startedAt: number;
  costUsd?: number;
}

export interface ProjectIndexStatus {
  projectId: number;
  phase: ProjectIndexPhase;
  watcherActive: boolean;
  /** Files waiting in the dirty queue for the next incremental drain. */
  dirtyPending: number;
  fileCount: number;
  symbolCount: number;
  /** Files whose LLM/embedding layer lags current content (dumb→smart gap). */
  semanticStaleCount: number;
  /** The live pass (structural/semantic/embeddings) — undefined when idle. */
  activeRun?: ActiveIndexRun;
  /** @deprecated Use {@link activeRun}. Kept in sync for the StatusBar chip. */
  progress?: { current: number; total: number };
  lastStructuralAt: string | null;
  lastSemanticAt: string | null;
  error?: string;
}

export type DirtyKind = 'upsert' | 'delete';

export interface DirtyEvent {
  /** Project-relative, forward-slash path. */
  path: string;
  kind: DirtyKind;
}

/**
 * Filesystem change surfaced to the UI (live file tree + open-tab reload).
 * Superset of DirtyEvent: directories flow here but never into the indexer.
 */
export interface FsEvent {
  /** Project-relative, forward-slash path. */
  path: string;
  kind: DirtyKind;
  isDir: boolean;
}

export interface StructuralRunSummary {
  totalFiles: number;
  indexed: number;
  removed: number;
  skipped: number;
  errorCount: number;
  durationMs: number;
  aborted?: 'too_large' | 'signal' | 'empty_scan';
}

export interface IndexFilesSummary {
  indexed: number;
  skippedUnchanged: number;
  skippedIgnored: number;
  removed: number;
  errors: number;
}

export interface StructuralProgressFrame {
  current: number;
  total: number;
  currentFile: string;
  /**
   * Which sub-phase emitted this frame. 'scanning' frames flow during the
   * (otherwise silent) tree walk — `total` may be 0 until the walk finishes.
   * Omitted/'indexing' = the per-file tree-sitter pass. Lets the UI keep the
   * "Scanning…" chip alive instead of showing a frozen spinner.
   */
  phase?: 'scanning' | 'indexing';
}

/**
 * The three structural operations the service needs. Implementations:
 * in-process (fallback, always available) and the indexer worker client
 * (keeps scanner/parse/SQLite writes off the main thread).
 */
export interface StructuralExecutor {
  runStructuralIndex(
    projectId: number,
    opts: {
      maxFiles?: number;
      /** Manual reindex bypasses the empty-scan anti-wipe guard. */
      allowEmptyWipe?: boolean;
      onProgress?: (p: StructuralProgressFrame) => void;
    },
  ): Promise<StructuralRunSummary>;
  indexFiles(projectId: number, relPaths: string[]): Promise<IndexFilesSummary>;
  removeFiles(projectId: number, relPaths: string[]): Promise<{ removed: number }>;
}

export interface ProjectIndexSettings {
  /** MCP_AUTO_INDEX_STRUCTURAL — master switch for auto runs on open. */
  autoIndex: boolean;
  /** MCP_AUTO_WATCH — real-time watcher per opened project. */
  autoWatch: boolean;
  /** MCP_AUTO_INDEX_MAX_FILES — candidate cap before bailing too_large. */
  maxFiles: number;
  /** MCP_WATCH_MAX_PROJECTS — LRU cap on concurrently watched projects. */
  maxWatchedProjects: number;
  /** MCP_WATCH_DEBOUNCE_MS — chokidar burst coalescing. */
  watchDebounceMs: number;
  /** MCP_WATCH_OPEN_DELAY_MS — defer recursive watcher startup after UI subscribe. */
  watchOpenDelayMs: number;
  /** MCP_WATCH_IDLE_MS — stop recursive watcher after the last fs subscriber leaves. */
  watchIdleMs: number;
  /**
   * MCP_INDEX_OPEN_DELAY_MS — defer the CPU-bound structural run on a
   * non-manual open so the renderer's first paint + screen mount finish
   * before the indexer worker pins a core. 0 = run immediately.
   */
  openDelayMs: number;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Like envInt but accepts 0 (an explicit "disable the delay"). */
function envIntZero(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

/** Read at call time so admin-settings changes apply without a restart. */
export function readProjectIndexSettings(): ProjectIndexSettings {
  return {
    autoIndex: process.env.MCP_AUTO_INDEX_STRUCTURAL !== '0',
    autoWatch: process.env.MCP_AUTO_WATCH !== '0',
    maxFiles: envInt('MCP_AUTO_INDEX_MAX_FILES', 20000),
    maxWatchedProjects: envInt('MCP_WATCH_MAX_PROJECTS', 3),
    watchDebounceMs: envInt('MCP_WATCH_DEBOUNCE_MS', 1000),
    watchOpenDelayMs: envIntZero('MCP_WATCH_OPEN_DELAY_MS', 1200),
    watchIdleMs: envIntZero('MCP_WATCH_IDLE_MS', 60000),
    openDelayMs: envIntZero('MCP_INDEX_OPEN_DELAY_MS', 700),
  };
}
