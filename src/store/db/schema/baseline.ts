// AUTO-GENERATED baseline schema for the code-context server.
// Derived from a fully-migrated index.db, pruned to retrieval + provider + infra
// tables (IDE-specific tables dropped). Regenerate via scripts/_gen_baseline.mjs.
/* eslint-disable */
export const BASELINE_DDL = String.raw`
CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE IF NOT EXISTS costs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        operation TEXT NOT NULL,
        file_path TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE IF NOT EXISTS explore_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'done',
        stop_reason TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        trail TEXT NOT NULL DEFAULT '[]',
        report TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE INDEX IF NOT EXISTS idx_explore_runs_project ON explore_runs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS embedding_configs (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        name       TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0,
        config     TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE IF NOT EXISTS file_concepts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        concept TEXT NOT NULL
      );

CREATE VIRTUAL TABLE IF NOT EXISTS file_contents_fts USING fts5(
      content,
      content='',
      contentless_delete=1,
      detail='column',
      tokenize='unicode61 remove_diacritics 2'
    );

CREATE TABLE IF NOT EXISTS file_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
        import_path TEXT NOT NULL,
        dep_type TEXT NOT NULL DEFAULT 'internal'
      );

CREATE TABLE IF NOT EXISTS file_history_blobs (
        hash       TEXT PRIMARY KEY,
        content    TEXT NOT NULL,
        size       INTEGER NOT NULL,
        refcount   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE IF NOT EXISTS file_local_history (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id     INTEGER NOT NULL,
        path           TEXT NOT NULL,
        content_hash   TEXT,
        size           INTEGER NOT NULL DEFAULT 0,
        kind           TEXT NOT NULL,
        label          TEXT,
        existed_before INTEGER NOT NULL DEFAULT 1,
        oversized      INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE IF NOT EXISTS file_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        concepts TEXT NOT NULL DEFAULT '[]',
        symbols TEXT NOT NULL DEFAULT '[]'
      );

CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'unknown',
        size INTEGER NOT NULL DEFAULT 0,
        line_count INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        concepts TEXT NOT NULL DEFAULT '[]',
        dependencies TEXT NOT NULL DEFAULT '[]',
        internal_deps TEXT NOT NULL DEFAULT '[]',
        external_deps TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '[]',
        complexity TEXT NOT NULL DEFAULT 'low',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')), layer TEXT NOT NULL DEFAULT 'unknown', is_entry_point INTEGER NOT NULL DEFAULT 0, is_test INTEGER NOT NULL DEFAULT 0, is_generated INTEGER NOT NULL DEFAULT 0, embedding_hash TEXT, structure_hash TEXT, structure_embedding BLOB, index_tier TEXT, mapper_reason TEXT, mtime_ms INTEGER, semantic_hash TEXT,
        UNIQUE(project_id, path)
      );

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      path, summary, concepts, content='files', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

CREATE TABLE IF NOT EXISTS model_prices (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        provider             TEXT NOT NULL DEFAULT '',
        model_id             TEXT NOT NULL,
        input_per_mtok       REAL,
        output_per_mtok      REAL,
        cache_read_per_mtok  REAL,
        cache_write_per_mtok REAL,
        currency             TEXT NOT NULL DEFAULT 'USD',
        source               TEXT NOT NULL,
        source_model_ref     TEXT,
        fetched_at           TEXT,
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider, model_id, source)
      );

CREATE TABLE IF NOT EXISTS models_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL UNIQUE,
        models TEXT NOT NULL DEFAULT '[]',
        fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE IF NOT EXISTS oauth_tokens (
        provider_id   TEXT PRIMARY KEY REFERENCES provider_configs(id) ON DELETE CASCADE,
        access_token  TEXT NOT NULL,
        refresh_token TEXT,
        expires_at    INTEGER,
        scope         TEXT,
        extra         TEXT,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE IF NOT EXISTS pending_vector_deletes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        vector_id     TEXT NOT NULL UNIQUE,
        project_name  TEXT,
        first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
        last_attempt  TEXT,
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT
      );

CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL,
        description TEXT,
        provider TEXT,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_indexed TEXT,
        file_count INTEGER NOT NULL DEFAULT 0,
        symbol_count INTEGER NOT NULL DEFAULT 0
      , group_name TEXT, embeddings_enabled INTEGER NOT NULL DEFAULT 1, search_mode TEXT NOT NULL DEFAULT 'hybrid', pending_vector_gc INTEGER NOT NULL DEFAULT 0, embedding_fingerprint TEXT, memory_enabled INTEGER NOT NULL DEFAULT 1, node_version TEXT, runner_shell TEXT, builder_json TEXT, structural_indexed_at TEXT, is_synthetic INTEGER NOT NULL DEFAULT 0, language_levels TEXT, db_path TEXT, db_split_status TEXT NOT NULL DEFAULT 'pending', db_split_at TEXT, db_split_err TEXT, db_split_attempts INTEGER NOT NULL DEFAULT 0, sessions_split_done INTEGER NOT NULL DEFAULT 0, vectors_split_status TEXT NOT NULL DEFAULT 'pending', vectors_split_at TEXT, vectors_split_err TEXT, db_purged_at TEXT, runtime_versions TEXT, git_remote TEXT, default_branch TEXT, summary TEXT);

CREATE TABLE IF NOT EXISTS provider_configs (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL,
        base_url      TEXT,
        api_key       TEXT,
        auth_mode     TEXT NOT NULL DEFAULT 'api_key',
        enabled       INTEGER NOT NULL DEFAULT 1,
        use_for_agent INTEGER NOT NULL DEFAULT 1,
        use_for_coder INTEGER NOT NULL DEFAULT 1,
        is_default    INTEGER NOT NULL DEFAULT 0,
        extra         TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      , fallback_provider_id TEXT DEFAULT NULL, use_for_general INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS provider_models (
        provider_id          TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
        model_id             TEXT NOT NULL,
        mode                 TEXT NOT NULL DEFAULT '',
        name                 TEXT NOT NULL,
        context_window       INTEGER,
        default_max_tokens   INTEGER,
        can_reason           INTEGER NOT NULL DEFAULT 0,
        supports_attachments INTEGER NOT NULL DEFAULT 0,
        enabled              INTEGER NOT NULL DEFAULT 1,
        source               TEXT NOT NULL DEFAULT 'manual',
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')), display_name TEXT, description TEXT, default_reasoning_level TEXT, supported_reasoning_levels TEXT, apply_patch_tool_type TEXT, available_in_plans TEXT, minimal_client_version TEXT, visibility TEXT, supported_in_api INTEGER, input_modalities TEXT, max_tools INTEGER,
        PRIMARY KEY (provider_id, model_id, mode)
      );

CREATE TABLE IF NOT EXISTS reranker_configs (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        name       TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0,
        config     TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        total_files INTEGER NOT NULL DEFAULT 0,
        indexed_files INTEGER NOT NULL DEFAULT 0,
        skipped_files INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        provider TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        embedding_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0
      , phase_timings_json TEXT, peak_rss_mb INTEGER, kind TEXT NOT NULL DEFAULT 'full');

CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE IF NOT EXISTS snapshot_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        file_hash_at_creation TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(snapshot_id, file_path)
      );

CREATE TABLE IF NOT EXISTS snapshot_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by TEXT NOT NULL DEFAULT 'manual'
      );

CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'note',
        content TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_by TEXT NOT NULL DEFAULT 'manual'
      , embedding_hash TEXT, source TEXT NOT NULL DEFAULT 'manual', importance REAL NOT NULL DEFAULT 0.5, last_accessed_at TEXT, access_count INTEGER NOT NULL DEFAULT 0, archived_at TEXT, archived_reason TEXT, scope TEXT NOT NULL DEFAULT 'project');

CREATE VIRTUAL TABLE IF NOT EXISTS snapshots_fts USING fts5(
      title, content, tags,
      content='snapshots', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

CREATE TABLE IF NOT EXISTS symbol_references (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
        symbol_name TEXT NOT NULL,
        referencing_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        referencing_file_path TEXT NOT NULL,
        line INTEGER,
        context TEXT
      , col INTEGER);

CREATE TABLE IF NOT EXISTS symbol_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        related_symbol_name TEXT NOT NULL,
        relation_type TEXT NOT NULL
      );

CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        signature TEXT NOT NULL DEFAULT '',
        parent TEXT,
        modifiers TEXT NOT NULL DEFAULT '[]',
        return_type TEXT,
        parameters TEXT,
        line INTEGER,
        comment TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      , stable_id TEXT, embedding_hash TEXT, body_embedding_hash TEXT, col INTEGER, end_line INTEGER, exported INTEGER NOT NULL DEFAULT 0);

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      name, kind, signature, comment, tags, file_path, parent,
      content='symbols', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

CREATE TABLE IF NOT EXISTS vector_ids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        vector_id TEXT NOT NULL,
        file_path TEXT,
        type TEXT NOT NULL DEFAULT 'file',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE IF NOT EXISTS vector_store_configs (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        name       TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0,
        config     TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT '[]',
        secret TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        last_triggered TEXT,
        last_status INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE INDEX IF NOT EXISTS idx_costs_project ON costs(project_id);

CREATE INDEX IF NOT EXISTS idx_costs_run ON costs(run_id);

CREATE INDEX IF NOT EXISTS idx_file_concepts_file ON file_concepts(file_id);

CREATE INDEX IF NOT EXISTS idx_file_concepts_project_concept ON file_concepts(project_id, concept);

CREATE INDEX IF NOT EXISTS idx_file_deps_source ON file_dependencies(source_file_id);

CREATE INDEX IF NOT EXISTS idx_file_deps_target ON file_dependencies(target_file_id);

CREATE INDEX IF NOT EXISTS idx_flh_created
        ON file_local_history(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_flh_file
        ON file_local_history(project_id, path, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_file_snapshots_run ON file_snapshots(run_id);

CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);

CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);

CREATE INDEX IF NOT EXISTS idx_files_project_embedding ON files(project_id, embedding_hash);

CREATE INDEX IF NOT EXISTS idx_files_project_path ON files(project_id, path);

CREATE INDEX IF NOT EXISTS idx_files_semantic ON files(project_id, semantic_hash);

CREATE INDEX IF NOT EXISTS idx_files_tier
        ON files(project_id, index_tier);

CREATE INDEX IF NOT EXISTS idx_model_prices_model
        ON model_prices(model_id);

CREATE INDEX IF NOT EXISTS idx_model_prices_source
        ON model_prices(source);

CREATE INDEX IF NOT EXISTS idx_pending_vector_deletes_attempt
        ON pending_vector_deletes(last_attempt);

CREATE INDEX IF NOT EXISTS idx_provider_configs_enabled
        ON provider_configs(enabled, use_for_coder, use_for_agent);

CREATE INDEX IF NOT EXISTS idx_provider_models_provider
        ON provider_models(provider_id, enabled);

CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);

CREATE INDEX IF NOT EXISTS idx_snapshot_files_snapshot
        ON snapshot_files(snapshot_id);

CREATE INDEX IF NOT EXISTS idx_snapshot_versions_snapshot ON snapshot_versions(snapshot_id);

CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id);

CREATE INDEX IF NOT EXISTS idx_snapshots_project_live
        ON snapshots(project_id, archived_at);

CREATE INDEX IF NOT EXISTS idx_snapshots_scope ON snapshots(scope);

CREATE INDEX IF NOT EXISTS idx_symbol_refs_file ON symbol_references(referencing_file_id);

CREATE INDEX IF NOT EXISTS idx_symbol_refs_name ON symbol_references(symbol_name);

CREATE INDEX IF NOT EXISTS idx_symbol_rels_name ON symbol_relations(related_symbol_name);

CREATE INDEX IF NOT EXISTS idx_symbol_rels_symbol ON symbol_relations(symbol_id);

CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);

CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent);

CREATE INDEX IF NOT EXISTS idx_symbols_project ON symbols(project_id);

CREATE INDEX IF NOT EXISTS idx_symbols_project_name ON symbols(project_id, name);

CREATE INDEX IF NOT EXISTS idx_symbols_stable_id
       ON symbols(project_id, stable_id);

CREATE INDEX IF NOT EXISTS idx_vector_ids_project ON vector_ids(project_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vector_ids_unique
        ON vector_ids(project_id, vector_id);

CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, path, summary, concepts)
      VALUES ('delete', old.id, old.path, old.summary, old.concepts);
    END;

CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
      INSERT INTO files_fts(rowid, path, summary, concepts)
      VALUES (new.id, new.path, new.summary, new.concepts);
    END;

CREATE TRIGGER IF NOT EXISTS files_contents_ad AFTER DELETE ON files BEGIN
      DELETE FROM file_contents_fts WHERE rowid = old.id;
    END;

CREATE TRIGGER IF NOT EXISTS snapshots_ad AFTER DELETE ON snapshots BEGIN
      INSERT INTO snapshots_fts(snapshots_fts, rowid, title, content, tags)
      VALUES ('delete', old.id, old.title, old.content, old.tags);
    END;

CREATE TRIGGER IF NOT EXISTS snapshots_ai AFTER INSERT ON snapshots BEGIN
      INSERT INTO snapshots_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, kind, signature, comment, tags, file_path, parent)
      VALUES ('delete', old.id, old.name, old.kind, old.signature, COALESCE(old.comment,''), old.tags, old.file_path, COALESCE(old.parent,''));
    END;

CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
      INSERT INTO symbols_fts(rowid, name, kind, signature, comment, tags, file_path, parent)
      VALUES (new.id, new.name, new.kind, new.signature, COALESCE(new.comment,''), new.tags, new.file_path, COALESCE(new.parent,''));
    END;
`;
