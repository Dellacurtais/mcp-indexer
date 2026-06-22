/**
 * Copy manifest for the tiered-hybrid DB split (plan §8.4).
 *
 * Lists the project-scoped tables to move into a project's own DB, in
 * dependency order (parents before children). P2 ships the INDEX class only;
 * SESSION/SCOPE classes are added in P3. Every table here is filtered by a
 * direct `project_id` column. The copy engine tolerates a missing table/column
 * (partial schemas) the same way `projects.clearData` does.
 *
 * Because both DBs are built from the SAME schema (see project-schema.ts), the
 * copy is `INSERT INTO main.t SELECT <cols> FROM legacy.t WHERE project_id=?`
 * with identical column sets — `id` is preserved verbatim.
 */
export type SplitClass = 'INDEX' | 'FEATURE';

export interface ManifestEntry {
  table: string;
  cls: SplitClass;
  /**
   * WHERE clause used to select THIS project's rows from the ATTACHed central
   * DB (aliased `legacy`). Uses the named param `@pid`. Defaults to
   * `project_id = @pid` (direct project-scoped tables). Child/filtered tables
   * pass a custom clause (e.g. a `collection_id IN (SELECT … FROM legacy.…)`
   * subquery, or a `kind='studio' AND project_id=@pid` filter for hybrids).
   */
  where?: string;
}

const PID = 'project_id = @pid';

/** INDEX-class tables. Order: parents before children (FK-safe even with FK on). */
export const INDEX_TABLES: ManifestEntry[] = [
  { table: 'files', cls: 'INDEX' },
  { table: 'symbols', cls: 'INDEX' },
  { table: 'symbol_references', cls: 'INDEX' },
  { table: 'symbol_relations', cls: 'INDEX' },
  { table: 'file_concepts', cls: 'INDEX' },
  { table: 'file_dependencies', cls: 'INDEX' },
  { table: 'file_snapshots', cls: 'INDEX' },
  // NOTE: `runs` + `costs` stay CENTRAL (telemetry/stats — faithful platform
  // usage stats). Intentionally NOT in the per-project manifest. See plan §4.
  { table: 'vector_ids', cls: 'INDEX' },
  { table: 'embedding_lsh_buckets', cls: 'INDEX' },
  { table: 'embedding_simhash_signatures', cls: 'INDEX' },
  { table: 'webhooks', cls: 'INDEX' },
];

/**
 * FEATURE-class tables (R1). All project-scoped, in dependency order. Hybrids
 * (pipelines, design_system) copy ONLY the project rows; QA + quality stay
 * central (no project_id). `file_history_blobs` is a content-addressed shared
 * pool — copy only the blobs referenced by THIS project's local history.
 */
export const FEATURE_TABLES: ManifestEntry[] = [
  // API client (147) — collections/envs are direct; children join via collection.
  { table: 'api_collections', cls: 'FEATURE' },
  { table: 'api_environments', cls: 'FEATURE' },
  { table: 'api_requests', cls: 'FEATURE', where: 'collection_id IN (SELECT id FROM legacy.api_collections WHERE project_id = @pid)' },
  { table: 'api_request_history', cls: 'FEATURE', where: 'request_id IN (SELECT id FROM legacy.api_requests WHERE collection_id IN (SELECT id FROM legacy.api_collections WHERE project_id = @pid))' },
  { table: 'api_regression_runs', cls: 'FEATURE', where: 'collection_id IN (SELECT id FROM legacy.api_collections WHERE project_id = @pid)' },
  // Builder checkpoints (144), doc suggestions (096), doc links (134) — direct.
  { table: 'builder_checkpoints', cls: 'FEATURE' },
  { table: 'doc_source_suggestions', cls: 'FEATURE' },
  { table: 'project_doc_collections', cls: 'FEATURE' },
  // File local history (160) — history direct; blobs are the referenced pool.
  { table: 'file_local_history', cls: 'FEATURE' },
  { table: 'file_history_blobs', cls: 'FEATURE', where: "hash IN (SELECT DISTINCT content_hash FROM legacy.file_local_history WHERE project_id = @pid AND content_hash IS NOT NULL)" },
  // Pipelines (058/119) — ONLY project-scoped rows (company stay central).
  { table: 'pipelines', cls: 'FEATURE' },
  { table: 'pipeline_executions', cls: 'FEATURE' },
  { table: 'pipeline_node_executions', cls: 'FEATURE', where: 'execution_id IN (SELECT id FROM legacy.pipeline_executions WHERE project_id = @pid)' },
  // Design System (048/132) — ONLY kind='studio' (legacy company stay central).
  { table: 'design_system_sessions', cls: 'FEATURE', where: "kind = 'studio' AND project_id = @pid" },
  { table: 'design_system_versions', cls: 'FEATURE', where: "ds_session_id IN (SELECT id FROM legacy.design_system_sessions WHERE kind='studio' AND project_id = @pid)" },
  // components link to a VERSION (version_id → design_system_versions), not the
  // session directly — filter transitively through the studio versions.
  { table: 'design_system_components', cls: 'FEATURE', where: "version_id IN (SELECT id FROM legacy.design_system_versions WHERE ds_session_id IN (SELECT id FROM legacy.design_system_sessions WHERE kind='studio' AND project_id = @pid))" },
  // Training (121) — datasets direct; children join via dataset.
  { table: 'training_datasets', cls: 'FEATURE' },
  { table: 'training_examples', cls: 'FEATURE', where: 'dataset_id IN (SELECT id FROM legacy.training_datasets WHERE project_id = @pid)' },
  { table: 'training_runs', cls: 'FEATURE', where: 'dataset_id IN (SELECT id FROM legacy.training_datasets WHERE project_id = @pid)' },
  // Per-project runtime/shell config (168) — direct project_id; travels with the folder.
  { table: 'project_runtime_config', cls: 'FEATURE' },
];

/** The default WHERE for a manifest entry (direct project_id) unless overridden. */
export function entryWhere(e: ManifestEntry): string { return e.where ?? PID; }

/** The set of classes a given split run copies. INDEX always; FEATURE on R1+. */
export function manifestFor(classes: SplitClass[]): ManifestEntry[] {
  const all = [...INDEX_TABLES, ...FEATURE_TABLES];
  return all.filter((e) => classes.includes(e.cls));
}
