import { CodeIndexDB } from '@ctx/store/db.js';
import { loadConfig, type IndexerConfig } from '@ctx/shared/utils/config.js';
import { ProviderStore } from '@ctx/store/provider-store.js';
import { HybridSearch } from '@ctx/indexer/search/hybrid.js';
import { createReranker } from '@ctx/indexer/search/reranker.js';
import type { EmbeddingService } from '@ctx/indexer/search/embeddings.js';
import type { VectorStore } from '@ctx/store/vectors.js';
import {
  createAndSeedProviderStore,
  createSearchBundle,
} from '@ctx/indexer/bootstrap/index.js';

/**
 * Retrieval-only tool context. The upstream IDE context also carried snapshot /
 * diff / export / webhook / cost / model-discovery services; those backed
 * tools that code-context does not expose and are dropped here.
 */
export interface ToolContext {
  config: IndexerConfig;
  db: CodeIndexDB;
  providerStore: ProviderStore;
  embeddingService: EmbeddingService;
  vectorStore: VectorStore;
  hybridSearch: HybridSearch;
}

/**
 * Build a fresh context that opens its own DB (used by one-shot CLI paths).
 * The long-running daemon builds the context from its already-open DB + search
 * bundle instead (see cli/commands/context.ts), so it can share one handle with
 * the watcher.
 */
export function buildContext(): ToolContext {
  const config = loadConfig();
  const db = new CodeIndexDB(config.dbPath);
  const providerStore = createAndSeedProviderStore(config.dbPath);
  const { embeddingService, vectorStore, hybridSearch } = createSearchBundle(
    db,
    providerStore,
    createReranker(providerStore),
  );
  return { config, db, providerStore, embeddingService, vectorStore, hybridSearch };
}
