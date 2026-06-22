/**
 * Seed the embedding + vector-store defaults.
 *
 * code-context is OFFLINE-BY-DEFAULT: a local ONNX embedding model (zero API
 * key) + the embedded sqlite-vec vector store are made the enabled defaults,
 * even if the environment happens to carry remote credentials (e.g. an inherited
 * MCP_INDEX_WORKER_URL from some other tool's `.env`). A remote backend is used
 * ONLY when the operator explicitly opts in with `MCP_EMBEDDINGS=remote`, in
 * which case whatever the store seeded from env (Cloudflare / Qdrant / Pinecone)
 * stays the default and local is added only as a fallback.
 */
import type { CodeIndexDB } from '@ctx/store/db.js';
import * as embedding from '@ctx/store/provider/embedding.js';
import * as vectorStore from '@ctx/store/provider/vector-store.js';

const DEFAULT_EMBEDDING_MODEL =
  process.env.MCP_EMBEDDING_MODEL?.trim() || 'Xenova/multilingual-e5-small';

function upsertLocalEmbedding(raw: ReturnType<CodeIndexDB['raw']>, isDefault: boolean): void {
  embedding.upsert(raw, {
    id: 'local',
    kind: 'local',
    name: 'Local ONNX (Xenova)',
    enabled: true,
    is_default: isDefault,
    config: { model: DEFAULT_EMBEDDING_MODEL },
  });
}

function upsertSqliteVec(raw: ReturnType<CodeIndexDB['raw']>, isDefault: boolean): void {
  vectorStore.upsert(raw, {
    id: 'sqlite-vec',
    kind: 'sqlite-vec',
    name: 'SQLite (sqlite-vec)',
    enabled: true,
    is_default: isDefault,
    config: {},
  });
}

export function seedLocalDefaults(db: CodeIndexDB): void {
  const raw = db.raw();
  const remoteOptIn = process.env.MCP_EMBEDDINGS?.trim().toLowerCase() === 'remote';

  if (remoteOptIn) {
    // Keep the env-seeded remote backend as default; add local only as a fallback.
    if (embedding.list(raw).length === 0) upsertLocalEmbedding(raw, true);
    if (vectorStore.list(raw).length === 0) upsertSqliteVec(raw, true);
    return;
  }

  // Offline by default: force local ONNX + sqlite-vec to be THE enabled default,
  // demoting any backend the store seeded from inherited env credentials.
  raw.prepare('UPDATE embedding_configs SET is_default = 0').run();
  upsertLocalEmbedding(raw, true);
  raw.prepare('UPDATE vector_store_configs SET is_default = 0').run();
  upsertSqliteVec(raw, true);
}
