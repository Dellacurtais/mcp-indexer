/**
 * @ctx/indexer — frozen public surface consumed by apps (cli, http-api,
 * mcp-server) and benchmarks. Internal modules live under
 * indexer/, search/, workers/, bootstrap/ and may also be imported via
 * subpaths (e.g. "@ctx/indexer/search/hybrid.js") when callers need a
 * specific class without bloating this barrel.
 */
export { HybridSearch } from './search/hybrid.js';
export type { SearchDiagnostics } from './search/hybrid.js';
export { createReranker } from './search/reranker.js';
export { RecentFilesSource } from './search/recent-files-source.js';
export type {
  RecentFileEntry,
  RecentFilesMatch,
  RecentFilesSourceOptions,
} from './search/recent-files-source.js';
export { makeHybridSearchCacheInvalidator } from './search/cache-invalidator.js';
export type {
  IndexerFilesUpdatedEvent,
  IndexerFilesUpdatedListener,
} from './indexer/indexer-events.js';

// I5 — multi-action reranker (Sprint 3)
export {
  NullMultiActionReranker,
  SingleActionAdapter,
  weightedActionFusion,
  toRerankResults,
  DEFAULT_ACTION_WEIGHTS,
  type MultiActionRerankerService,
  type MultiActionRerankResult,
  type RerankerAction,
  type ActionWeights,
  type WeightedActionResult,
} from './search/multi-action-reranker.js';
export type {
  EmbeddingService,
} from './search/embeddings.js';
export {
  NullEmbeddingService,
  createEmbeddingService,
} from './search/embeddings.js';
export type { VectorStore } from '@ctx/store/vectors.js';
export {
  createAndSeedProviderStore,
  createSearchBundle,
  deriveKindLabel,
} from './bootstrap/index.js';
export type { SearchBundle } from './bootstrap/search-bundle.js';
