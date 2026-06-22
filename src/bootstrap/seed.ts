/**
 * Seed the offline retrieval defaults: a local ONNX embedding model (zero API
 * key) and the embedded sqlite-vec vector store. Idempotent — only inserts when
 * the operator has not already configured a backend. Remote backends still seed
 * from env via the store's own `seedFromEnvIfEmpty` (Cloudflare / Qdrant /
 * Pinecone), so setting e.g. MCP_INDEX_WORKER_URL takes precedence naturally.
 */
import type { CodeIndexDB } from '@ctx/store/db.js';
import * as embedding from '@ctx/store/provider/embedding.js';
import * as vectorStore from '@ctx/store/provider/vector-store.js';

const DEFAULT_EMBEDDING_MODEL =
  process.env.MCP_EMBEDDING_MODEL?.trim() || 'Xenova/multilingual-e5-small';

export function seedLocalDefaults(db: CodeIndexDB): void {
  const raw = db.raw();

  if (embedding.list(raw).length === 0) {
    embedding.upsert(raw, {
      id: 'local',
      kind: 'local',
      name: 'Local ONNX (Xenova)',
      enabled: true,
      is_default: true,
      config: { model: DEFAULT_EMBEDDING_MODEL },
    });
  }

  if (vectorStore.list(raw).length === 0) {
    vectorStore.upsert(raw, {
      id: 'sqlite-vec',
      kind: 'sqlite-vec',
      name: 'SQLite (sqlite-vec)',
      enabled: true,
      is_default: true,
      config: {},
    });
  }
}
