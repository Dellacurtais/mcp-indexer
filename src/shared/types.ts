// ─── Provider Types ───────────────────────────────────────────────

export type ProviderName =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'gemini'
  | 'zai'
  | 'kimi-code';

export type SnapshotCategory = 'architecture' | 'decision' | 'pattern' | 'convention' | 'todo' | 'note' | 'gotcha' | 'procedure' | 'user' | 'feedback';

/** Memory scope: project-bound facts vs. global facts about the user (migration 145). */
export type SnapshotScope = 'project' | 'user';

export type ExportFormat = 'markdown' | 'json';

export type ExportSection =
  | 'overview'
  | 'architecture'
  | 'files'
  | 'symbols'
  | 'concepts'
  | 'api'
  | 'snapshots'
  | 'changelog';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'enum'
  | 'constant'
  | 'type'
  | 'method'
  | 'property'
  | 'variable'
  | 'module'
  | 'namespace'
  | 'other';

// 'completed_with_errors': run finished but some files or the embedding
// pipeline failed — the index is usable yet incomplete (error_count > 0).
// 'abandoned': stamped by markStaleRuns on runs orphaned by a crash.
export type RunStatus = 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'abandoned';

export type WebhookEvent =
  | 'index.start'
  | 'index.done'
  | 'index.failed'
  | 'watch.changed'
  | 'snapshot.created';

export type FileLayer = 'presentation' | 'business' | 'data' | 'infrastructure' | 'config' | 'test' | 'unknown';

// ─── Project ──────────────────────────────────────────────────────

export interface Project {
  id: number;
  name: string;
  root_path: string;
  description: string | null;
  group_name: string | null;
  provider: string | null;
  model: string | null;
  embeddings_enabled: number;
  search_mode: SearchMode;
  /** Per-project agent-memory toggle (migration 115; default 1 = on). */
  memory_enabled: number;
  /** Chosen Node runtime id (e.g. 'managed:20.11.0'); null = system default. */
  node_version: string | null;
  /** Shell id the runner launches commands with (e.g. 'git-bash'); null = system default. */
  runner_shell: string | null;
  /**
   * Builder-project config — JSON `{"stack":"react-ts","port":5180}`. When
   * set, this project was scaffolded as a V0-style builder (instrumented for
   * element selection); the project view shows the live-preview pane and
   * defaults the chat agent to `builder`. Null for ordinary projects.
   */
  builder_json: string | null;
  /**
   * Versão da linguagem por projeto (migration 157) — JSON
   * `{"php":"8.2","python":"3.11"}`. Entregue ao servidor LSP (Intelephense/Pyright)
   * para que completion/hover de símbolos nativos respeitem a versão. Null/ausente =
   * usar o default do servidor. Ver `@ctx/shared/utils/language-levels`.
   */
  language_levels: string | null;
  /**
   * Versão de RUNTIME (interpretador) por projeto para PHP/Python (migration 167)
   * — JSON `{"php":"managed:8.3.7","python":"managed:3.12.3"}`. É o interpretador
   * que o terminal/runner colocam no PATH (ver `runtime-resolve.ts`), distinto de
   * `language_levels` (alvo de análise do LSP). Node fica em `node_version`.
   * Null/ausente = default do sistema. Ver `@ctx/shared/utils/runtime-versions`.
   */
  runtime_versions: string | null;
  /**
   * Per-project package-manager preference (migration 169) — JSON
   * `{"node":"pnpm","python":"poetry"}`. Overrides the runner's lockfile
   * auto-detect and drives the dependency assistant (install/update). PHP is
   * fixed (composer), so no key. Missing/NULL = auto. Lives in the routed
   * `project_runtime_config` table; populated by the getProject overlay only.
   * See `@ctx/shared/utils/package-managers`.
   */
  package_managers: string | null;
  /**
   * Git remote URL + default branch (migration 170). Powers the cloud project
   * library: a synced project pointer carries `git_remote`, and "Import from
   * cloud" clones it. Auto-detected on open/scaffold; null when not a git repo.
   * Optional (like `framework`) so existing Project literals/mocks don't break.
   */
  git_remote?: string | null;
  default_branch?: string | null;
  /**
   * Frontend framework inferred from package.json at READ time (not persisted;
   * set by the `get` handler). Drives the preview element-selector mode
   * ("react" native detection vs the generic "universal" picker). Undefined on
   * rows not fetched through `get` (e.g. `listProjects`).
   */
  framework?: 'next' | 'react' | 'vue' | 'angular' | null;
  created_at: string;
  updated_at: string;
  last_indexed: string | null;
  /**
   * Last STRUCTURAL pass (tree-sitter symbols + FTS, no LLM/embeddings) —
   * migration 139. `last_indexed` keeps meaning "semantic index". A project
   * is tool-usable (symbols/grep/skeleton) when EITHER is set.
   */
  structural_indexed_at: string | null;
  file_count: number;
  symbol_count: number;
  /**
   * 1 when this is a synthetic global-session union project (migration 155) —
   * its `root_path` is a directory of junctions/symlinks to real projects.
   * Hidden from `listProjects`. Undefined/0 for normal projects.
   */
  is_synthetic?: number;
}

// ─── LLM Analysis ────────────────────────────────────────────────

export interface LLMReference {
  symbol_name: string;
  kind: SymbolKind;
  line?: number;
  /** Start column of the reference (1-based). Tree-sitter only; migration 141. */
  col?: number;
  snippet?: string;
}

export interface LLMSymbol {
  name: string;
  kind: SymbolKind;
  signature: string;
  parent: string | null;
  extends_from?: string;
  implements_list?: string[];
  modifiers: string[];
  return_type: string | null;
  parameters: string | null;
  line: number | null;
  /** End line of the symbol (1-indexed). Provided by tree-sitter; may be absent for LLM-extracted symbols. */
  end_line?: number;
  /** Start column (1-based, UTF-16 units — Monaco-compatible). Tree-sitter only; migration 141. */
  col?: number;
  /**
   * Per-language visibility (migration 141): TS export/default, Rust pub,
   * Go uppercase, PHP non-private member, Python non-underscore top-level;
   * fallback = top-level. Drives project-wide prefix completion.
   */
  exported?: boolean;
  comment: string | null;
  tags: string[];
}

export interface LLMFileAnalysis {
  language: string;
  summary: string;
  concepts: string[];
  dependencies: string[];
  internal_deps: string[];
  external_deps: string[];
  notes: string[];
  complexity: string;
  layer?: string;
  is_entry_point?: boolean;
  is_test?: boolean;
  is_generated?: boolean;
  symbols: LLMSymbol[];
  references?: LLMReference[];
}

export interface AnalysisResult {
  analysis: LLMFileAnalysis;
  inputTokens: number;
  outputTokens: number;
}

// ─── Database Records ─────────────────────────────────────────────

export interface DBFile {
  id: number;
  project_id: number;
  path: string;
  language: string;
  size: number;
  line_count: number;
  content_hash: string;
  summary: string;
  concepts: string; // JSON array
  dependencies: string; // JSON array
  internal_deps: string; // JSON array
  external_deps: string; // JSON array
  notes: string; // JSON array
  complexity: string;
  layer: string;
  is_entry_point: number; // SQLite boolean
  is_test: number;
  is_generated: number;
  /**
   * Content hash at the last SEMANTIC (LLM) pass — migration 139. Diverging
   * from `content_hash` marks the file's summary/concepts as stale; NULL on
   * structurally-indexed files that never saw the LLM.
   */
  semantic_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface DBSymbol {
  id: number;
  project_id: number;
  file_id: number;
  file_path: string;
  name: string;
  kind: SymbolKind;
  signature: string;
  parent: string | null;
  modifiers: string; // JSON array
  return_type: string | null;
  parameters: string | null;
  line: number | null;
  /** Start column (1-based) — migration 141; NULL on pre-141 rows until re-extract. */
  col: number | null;
  /** End line (1-based) — migration 141. */
  end_line: number | null;
  /** Visibility flag (migration 141) — see LLMSymbol.exported. */
  exported: number;
  comment: string | null;
  tags: string; // JSON array
  created_at: string;
  /**
   * Deterministic symbol identity. Derived from
   * `kind + name + parent + signature` (not `line`, which changes on
   * every edit), prefixed by project id and file path. Populated by
   * migration 002 for legacy rows and at upsert time for new ones.
   */
  stable_id: string | null;
}

// ─── Index Run ────────────────────────────────────────────────────

/** 'structural' = tree-sitter + FTS only (no LLM/embeddings). Migration 139. */
export type RunKind = 'full' | 'structural';

export interface IndexRun {
  id: number;
  project_id: number;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  total_files: number;
  indexed_files: number;
  skipped_files: number;
  error_count: number;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  embedding_tokens: number;
  estimated_cost_usd: number;
  /** JSON `{scan_ms, analyze_ms, embed_ms, sweep_ms}` (migration 138). */
  phase_timings_json: string | null;
  peak_rss_mb: number | null;
  kind: RunKind;
}

// ─── Cost Tracking ────────────────────────────────────────────────

export interface CostRecord {
  id: number;
  project_id: number;
  run_id: number | null;
  provider: string;
  model: string;
  operation: 'analysis' | 'embedding';
  file_path: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  created_at: string;
}

export interface CostSummary {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_embedding_tokens: number;
  /** Cost attributed to LLM analysis operations (summaries, symbol extraction). */
  llm_analysis_cost_usd: number;
  /** Cost attributed to embedding operations (vector store). */
  embedding_cost_usd: number;
  by_provider: Record<string, { cost_usd: number; input_tokens: number; output_tokens: number }>;
  by_project: Record<string, { cost_usd: number; runs: number }>;
  runs: number;
}

// ─── Context Snapshots ────────────────────────────────────────────

export interface ContextSnapshot {
  id: number;
  project_id: number;
  title: string;
  category: SnapshotCategory;
  content: string;
  tags: string; // JSON array
  created_at: string;
  updated_at: string;
  created_by: string;
  /** MD5 of the text fed to the embedding service. NULL = needs embedding. */
  embedding_hash: string | null;
  /** Memory provenance (migration 114): manual | agent | session | compaction | index. */
  source: string;
  /** 0..1 salience used to rank retrieval and survive consolidation (migration 114). */
  importance: number;
  /** Usage signal for retrieval ranking / decay (migration 114). */
  last_accessed_at: string | null;
  access_count: number;
  /** Soft-delete timestamp (migration 146). NULL = live; non-null = archived
   *  by the consolidator and excluded from every agent-facing read path. */
  archived_at?: string | null;
  /** Why the row was archived: "merged:<winnerId>" | "stale+cold+low-importance". */
  archived_reason?: string | null;
  /** Memory scope (migration 145). 'project' (default) or 'user' (global, on
   *  the reserved project 0). */
  scope?: SnapshotScope;
}

// ─── Webhooks ─────────────────────────────────────────────────────

export interface Webhook {
  id: number;
  project_id: number | null;
  url: string;
  events: string; // JSON array
  secret: string | null;
  active: boolean;
  last_triggered: string | null;
  last_status: number | null;
  created_at: string;
}

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  project: {
    id: number;
    name: string;
    root_path: string;
  };
  data: Record<string, unknown>;
}

// ─── Diff ─────────────────────────────────────────────────────────

export interface DiffSymbolEntry {
  name: string;
  kind: SymbolKind;
  signature: string;
}

export interface DiffFileModified {
  path: string;
  language: string;
  summary_before: string;
  summary_after: string;
  symbols_added: DiffSymbolEntry[];
  symbols_removed: DiffSymbolEntry[];
  concepts_added: string[];
  concepts_removed: string[];
}

export interface DiffFileEntry {
  path: string;
  language: string;
  summary: string;
}

export interface RunDiff {
  project_id: number;
  run_before: number;
  run_after: number;
  files_added: DiffFileEntry[];
  files_removed: DiffFileEntry[];
  files_modified: DiffFileModified[];
  total_symbols_added: number;
  total_symbols_removed: number;
  concepts_added: string[];
  concepts_removed: string[];
}

// ─── Export ───────────────────────────────────────────────────────

export interface ExportOptions {
  projectId: number;
  projectName: string;
  format: ExportFormat;
  sections: ExportSection[];
  outputPath?: string;
  includeSnapshots: boolean;
  includeCosts: boolean;
}

// ─── Search ───────────────────────────────────────────────────────

/**
 * `auto` is the planner-routed mode: the heuristics in
 * `core/search/planner.ts` pick the cheapest backend that still
 * answers the query well (fts for symbol lookups, hybrid+expanded
 * for natural-language questions). The other values are still
 * accepted for callers that want to force a specific path.
 */
export type SearchMode = 'fts' | 'vector' | 'hybrid' | 'auto';
export type SearchType = 'files' | 'symbols' | 'all';

export interface HybridSearchResult {
  id: number;
  type: 'file' | 'symbol';
  score: number;
  fts_rank: number | null;
  vector_score: number | null;
  data: DBFile | DBSymbol;
}

export interface SearchOptions {
  mode: SearchMode;
  type: SearchType;
  limit: number;
}

// ─── Vectors ──────────────────────────────────────────────────────

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: Record<string, string>;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata: Record<string, string>;
}

// ─── File Scanner ─────────────────────────────────────────────────

export interface ScannedFile {
  path: string;
  relativePath: string;
  /**
   * NOT populated by the scanner anymore — content is read lazily by
   * `processFile`, so the scan's peak memory is O(1 file) instead of the
   * whole changed set. Still present for tests/fixtures that inject it.
   */
  content?: string;
  hash: string;
  sizeBytes: number;
  lineCount: number;
  /** fs.stat mtime (ms) captured at scan time; persisted via files.mtime_ms. */
  mtimeMs?: number;
  /**
   * Mapper tier — `core`, `support`, or `on_demand`. `excluded` files
   * never reach this stage, so the field is one of the three positive
   * tiers. Optional for backwards compatibility; older callers ignore.
   */
  tier?: 'core' | 'support' | 'on_demand';
  /** Why the mapper picked this tier — surfaced in cost dashboards. */
  mapperReason?: string;
}

/** How each scanned file was classified — doubles as test observability. */
export interface ScanStats {
  /** Unchanged proven by mtime+size alone — zero bytes read. */
  statOnly: number;
  /** Files read + hashed (stat differed, or no stored mtime yet). */
  hashed: number;
  /** Skipped via stat size before any read. */
  skippedTooLarge: number;
  /** Listed by the glob but excluded by ignore rules (gitignore/.mcpindexignore/hard excludes). */
  ignored?: number;
}

export interface ScanResult {
  toIndex: ScannedFile[];
  unchanged: string[];
  toRemove: string[];
  /** Candidate files seen before an early abort, or the final candidate count. */
  totalFiles?: number;
  /** Early scan abort; lets callers bail before mutating project index state. */
  aborted?: 'too_large';
  stats?: ScanStats;
}

// ─── Index Result ─────────────────────────────────────────────────

/** Per-phase wall-clock + peak process RSS sampled during an index run. */
export interface RunPhaseTelemetry {
  scan_ms: number;
  analyze_ms: number;
  embed_ms: number;
  sweep_ms: number;
  peak_rss_mb: number;
}

export interface IndexResult {
  runId: number;
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  errorCount: number;
  durationMs: number;
  costUsd: number;
  phases?: RunPhaseTelemetry;
}

// ─── Model Discovery ─────────────────────────────────────────────

export interface DiscoveredModel {
  id: string;
  provider: ProviderName;
  name: string;
  capabilities: string[];
  cached_at: string;
}

// ─── File Snapshot (for diff) ─────────────────────────────────────

export interface FileSnapshot {
  id: number;
  run_id: number;
  project_id: number;
  file_path: string;
  content_hash: string;
  summary: string;
  concepts: string; // JSON array
  symbols: string; // JSON array
}

// ─── Vector ID Tracking ───────────────────────────────────────────

export interface VectorIdRecord {
  id: number;
  project_id: number;
  vector_id: string;
  file_path: string | null;
  type: 'file' | 'symbol' | 'symbol_body' | 'snapshot';
  created_at: string;
}

// ─── Stats ────────────────────────────────────────────────────────

export interface ProjectStats {
  file_count: number;
  symbol_count: number;
  languages: Record<string, number>;
  total_lines: number;
  total_size: number;
  last_indexed: string | null;
  /** Last structural (tree-sitter only) pass; see Project.structural_indexed_at. */
  structural_indexed_at: string | null;
  /** Files whose semantic layer (LLM summary/embeddings) lags current content. */
  semantic_stale_count: number;
  run_count: number;
}

// ─── Progress Callback ───────────────────────────────────────────

export interface IndexProgress {
  current: number;
  total: number;
  currentFile: string;
  elapsedMs: number;
  costUsd: number;
}

export type ProgressCallback = (progress: IndexProgress) => void;

// ─── Dependency Graph ────────────────────────────────────────────

export interface DBFileDependency {
  id: number;
  import_path: string;
  dep_type: string;
  target_file_path: string | null;
}

export interface DBFileDependent {
  id: number;
  import_path: string;
  source_file_path: string;
}

// ─── Symbol References (Call Graph) ──────────────────────────────

export interface DBSymbolReference {
  id: number;
  project_id: number;
  symbol_id: number | null;
  symbol_name: string;
  referencing_file_id: number;
  referencing_file_path: string;
  line: number | null;
  /** Start column (1-based) — migration 141; NULL on pre-141 rows. */
  col: number | null;
  context: string | null;
}

// ─── Symbol Relations (Hierarchy) ────────────────────────────────

export interface DBSymbolRelation {
  id: number;
  project_id: number;
  symbol_id: number;
  related_symbol_name: string;
  relation_type: 'extends' | 'implements' | 'mixes' | 'overrides';
}

// ─── Snapshot Version ────────────────────────────────────────────

export interface SnapshotVersion {
  id: number;
  snapshot_id: number;
  version: number;
  title: string;
  category: string;
  content: string;
  tags: string;
  updated_at: string;
  updated_by: string;
}
