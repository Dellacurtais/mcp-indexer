import type { CodeIndexDB } from '@ctx/store/db.js';
import type { IndexerConfig } from '@ctx/shared/utils/config.js';
import type { ProviderStore } from '@ctx/store/provider-store.js';
import type { HybridSearch } from '@ctx/indexer/search/hybrid.js';
import type { EmbeddingService } from '@ctx/indexer/search/embeddings.js';
import type { VectorStore } from '@ctx/store/vectors.js';

/**
 * Retrieval-only tool context. The upstream IDE context also carried snapshot /
 * diff / export / webhook / cost / model-discovery services; those backed tools
 * that code-context does not expose and are dropped here.
 *
 * The daemon builds this directly from its already-open DB + search bundle (see
 * cli/commands/context.ts) so it shares one handle with the watcher.
 */
export interface ToolContext {
  config: IndexerConfig;
  db: CodeIndexDB;
  providerStore: ProviderStore;
  embeddingService: EmbeddingService;
  vectorStore: VectorStore;
  hybridSearch: HybridSearch;
}
