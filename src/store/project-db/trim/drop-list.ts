/**
 * The CENTRAL tables to DROP from a per-project DB (C2 trim).
 *
 * The project DB is built from the full central schema (initSchema + runMigrations)
 * so it inherits ~93 central-only tables it never uses. This is the EXPLICIT
 * drop-list — we drop ONLY known-central tables. A future/unknown table is left
 * intact (harmless dead weight) rather than risking a complement-based drop that
 * could delete a mis-classified PROJECT table (data loss). `assertDisjointFromProject`
 * guards that none of these ever overlaps a project (manifest) table.
 */
import { INDEX_TABLES, FEATURE_TABLES } from '../../db-split/manifest.js';

/** External-content FTS vtabs over CENTRAL base tables — dropped before the base
 *  (DROP on the vtab removes its shadow tables). The KEPT code FTS (files_fts/
 *  symbols_fts/file_contents_fts) are NOT here. */
export const CENTRAL_FTS_VTABS = ['snapshots_fts', 'doc_chunks_fts'] as const;

/** Central tables present in the full schema but never used by a project DB. */
export const CENTRAL_DROP_TABLES: readonly string[] = [
  // session runtime + telemetry (central per the final scope decision)
  'coder_sessions', 'coder_messages', 'coder_plans', 'coder_tasks_state', 'coder_tool_calls',
  'coder_turn_telemetry', 'coder_investigations', 'coder_session_inputs', 'coder_session_memory',
  'coder_phase_profiles', 'coder_session_groups', 'coder_task_runs', 'coder_task_run_items',
  'coder_session_index', 'coder_session_projects',
  'session_file_baselines', 'session_file_edits', 'session_file_hunk_decisions',
  'session_file_review_comments', 'session_file_review_runs', 'session_disabled_tools',
  // stats (central per Etapa A)
  'runs', 'costs', 'project_cost_rollup',
  // user/project snapshots (central) + memory
  'snapshots', 'snapshot_files', 'snapshot_versions', 'memory_distill_log',
  // company + kanban
  'company_sessions', 'company_session_projects', 'company_session_envs', 'company_session_databases',
  'company_session_archives', 'company_sandboxes', 'company_sandbox_services', 'company_templates',
  'company_board', 'company_drive_files', 'company_local_projects', 'company_fronts', 'company_agent_runs',
  'kanban_cards', 'kanban_card_agents', 'kanban_card_dependencies', 'kanban_checklist_items', 'kanban_comments',
  // quality / counterfactual
  'quality_classifications', 'quality_interventions', 'counterfactual_logs',
  // docs corpus (global)
  'doc_collections', 'doc_sources', 'doc_chunks', 'doc_chunk_vectors', 'doc_vector_tombstones',
  'doc_rerank_cache', 'docs_research_sessions',
  // agents / supervision
  'agent_inbox', 'agent_board_watermarks', 'agent_supervision', 'agent_supervision_incidents',
  'sub_agent_result_cache',
  // providers / auth / mcp / models (global config)
  'provider_configs', 'provider_models', 'oauth_clients', 'oauth_auth_codes', 'oauth_tokens',
  'oauth_refresh_tokens', 'mcp_server_configs', 'mcp_server_tools', 'mcp_oauth_registrations',
  'mcp_oauth_tokens', 'mcp_oauth_pending', 'embedding_configs', 'embedding_store_configs',
  'vector_store_configs', 'reranker_configs', 'model_prices', 'models_cache', 'api_tokens',
  'auth_audit_log', 'app_settings', 'company_master_prompts',
  // skills / plugins / misc global
  'skill_definitions', 'skill_session_config', 'skill_usage_log', 'chrome_service_configs',
  'installed_plugins', 'plugin_storage', 'verdaccio_configs', 'disabled_tools_global',
  'pending_vector_deletes',
  // QA + pipeline global bindings/telemetry (company-scoped)
  'qa_test_runs', 'qa_test_results', 'pipeline_provider_bindings', 'pipeline_telemetry',
];

/** Project tables (from the copy manifest) + infra that MUST survive the trim. */
export function projectKeepTables(): Set<string> {
  const keep = new Set<string>(['projects', 'schema_version', 'sqlite_sequence', 'project_db_meta']);
  for (const e of [...INDEX_TABLES, ...FEATURE_TABLES]) keep.add(e.table);
  return keep;
}

/** Throw if the drop-list overlaps a project table (guards a classification slip). */
export function assertDisjointFromProject(): void {
  const keep = projectKeepTables();
  const overlap = CENTRAL_DROP_TABLES.filter((t) => keep.has(t));
  if (overlap.length > 0) {
    throw new Error(`[project-db/trim] drop-list overlaps project tables: ${overlap.join(', ')}`);
  }
}
