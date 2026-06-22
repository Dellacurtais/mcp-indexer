import type { DB } from '../types.js';

export function createBaseTables(db: DB): void {
  db.exec(`
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
      symbol_count INTEGER NOT NULL DEFAULT 0,
      git_remote TEXT,
      default_branch TEXT
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, path)
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

    CREATE TABLE IF NOT EXISTS vector_ids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      vector_id TEXT NOT NULL,
      file_path TEXT,
      type TEXT NOT NULL DEFAULT 'file',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS models_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL UNIQUE,
      models TEXT NOT NULL DEFAULT '[]',
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS file_concepts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      concept TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
      import_path TEXT NOT NULL,
      dep_type TEXT NOT NULL DEFAULT 'internal'
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
    );

    CREATE TABLE IF NOT EXISTS symbol_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      related_symbol_name TEXT NOT NULL,
      relation_type TEXT NOT NULL
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

    CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
    CREATE INDEX IF NOT EXISTS idx_files_project_path ON files(project_id, path);
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
    -- Embedding coverage COUNT(*)/COUNT(embedding_hash) per project becomes an
    -- index-only scan (no table row reads) — see embeddings.coverage().
    CREATE INDEX IF NOT EXISTS idx_files_project_embedding ON files(project_id, embedding_hash);
    CREATE INDEX IF NOT EXISTS idx_symbols_project ON symbols(project_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
    CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent);
    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id);
    CREATE INDEX IF NOT EXISTS idx_costs_project ON costs(project_id);
    CREATE INDEX IF NOT EXISTS idx_costs_run ON costs(run_id);
    CREATE INDEX IF NOT EXISTS idx_file_snapshots_run ON file_snapshots(run_id);
    CREATE INDEX IF NOT EXISTS idx_vector_ids_project ON vector_ids(project_id);

    CREATE INDEX IF NOT EXISTS idx_file_concepts_project_concept ON file_concepts(project_id, concept);
    CREATE INDEX IF NOT EXISTS idx_file_concepts_file ON file_concepts(file_id);
    CREATE INDEX IF NOT EXISTS idx_file_deps_source ON file_dependencies(source_file_id);
    CREATE INDEX IF NOT EXISTS idx_file_deps_target ON file_dependencies(target_file_id);
    CREATE INDEX IF NOT EXISTS idx_symbol_refs_name ON symbol_references(symbol_name);
    CREATE INDEX IF NOT EXISTS idx_symbol_refs_file ON symbol_references(referencing_file_id);
    CREATE INDEX IF NOT EXISTS idx_symbol_rels_symbol ON symbol_relations(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_symbol_rels_name ON symbol_relations(related_symbol_name);
    CREATE INDEX IF NOT EXISTS idx_snapshot_versions_snapshot ON snapshot_versions(snapshot_id);
  `);
}
