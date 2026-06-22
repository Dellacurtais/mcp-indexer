import type { CodeIndexDB } from '@ctx/store/db.js';
import type { ProviderStore } from '@ctx/store/provider-store.js';
import {
  createEmbeddingService,
  type EmbeddingService,
} from '@ctx/indexer/search/embeddings.js';
import {
  createVectorStore,
  NullVectorStore,
  type VectorStore,
} from '@ctx/store/vectors.js';
import { SqliteVecVectorStore } from '@ctx/store/sqlite-vec-store.js';
import { RoutingVectorStore } from '@ctx/store/vectors-routing.js';
import { projectDbFlags } from '@ctx/shared/utils/config.js';
import { HyDEService } from '@ctx/indexer/search/hyde.js';
import { HybridSearch } from '@ctx/indexer/search/hybrid.js';
import type { RerankerService } from '@ctx/indexer/search/reranker.js';
import type { RecentFilesSource } from '@ctx/indexer/search/recent-files-source.js';
import type { TelemetrySink } from '@ctx/candidate-pipeline';

export interface SearchBundle {
  embeddingService: EmbeddingService;
  vectorStore: VectorStore;
  /** Non-null variant; null when the configured store is `NullVectorStore`. */
  searchableVectorStore: VectorStore | null;
  hybridSearch: HybridSearch;
}

/**
 * Composes the full search stack (embeddings + vector store + HybridSearch)
 * from a ProviderStore. Consolidates the 3-way duplication that existed in
 * http-api/deps.ts, mcp-server/context.ts, and cli/helpers.ts.
 *
 * `reranker` is optional — only the MCP server currently wires it.
 * `recentFilesSource` is optional (I2 — Sprint 1) — only consulted when
 * `MCP_PIPELINES_RECENT_FILES_SOURCE=1`; absence leaves the legacy
 * 2-stream (FTS + Vector) RRF merge bit-identical.
 */
export function createSearchBundle(
  db: CodeIndexDB,
  providerStore: ProviderStore,
  reranker?: RerankerService,
  recentFilesSource?: RecentFilesSource,
  pipelineTelemetry?: TelemetrySink,
  /**
   * Pre-built embedding service to use instead of `createEmbeddingService`.
   * The http-api layer passes a worker-backed wrapper here (so local ONNX
   * inference runs off the main thread) while keeping all consumers —
   * snapshotService, hybridSearch, etc. — on the SAME instance. Other callers
   * (mcp-server, cli) omit it and get the plain in-process service.
   */
  embeddingOverride?: EmbeddingService,
): SearchBundle {
  const embeddingService = embeddingOverride ?? createEmbeddingService(providerStore);
  const rawVectorStore = createVectorStore(providerStore);
  const searchableRaw = rawVectorStore instanceof NullVectorStore ? null : rawVectorStore;
  // R2 routing flip — when the per-project vectors flag is on AND the backend is
  // the embedded sqlite-vec store, wrap with a namespace-routing facade so
  // `code:<project>` ops hit that project's own vectors.db while docs + snapshots
  // (no `code:` namespace) + remote backends stay central. Flag-off / Null /
  // remote → the raw store unchanged (byte-identical). Returned as BOTH
  // vectorStore + searchableVectorStore so EVERY consumer routes by namespace
  // regardless of which field it reads (code search + re-embed can't diverge).
  const routed: VectorStore | null =
    searchableRaw && projectDbFlags().vectors && searchableRaw instanceof SqliteVecVectorStore
      ? new RoutingVectorStore(searchableRaw, db)
      : searchableRaw;
  const vectorStore: VectorStore = routed ?? rawVectorStore;
  const searchableVectorStore = routed;

  const hydeService = new HyDEService(providerStore);
  const hybridSearch = new HybridSearch(
    db,
    searchableVectorStore,
    embeddingService,
    hydeService,
    reranker,
    recentFilesSource,
    pipelineTelemetry,
  );

  return { embeddingService, vectorStore, searchableVectorStore, hybridSearch };
}

/**
 * Derive short diagnostic kind labels (e.g. "cloudflare", "bedrock-titan")
 * from a service's class name. Used by the admin/debug panel.
 */
export function deriveKindLabel(
  instance: { constructor: { name: string } },
  suffix: 'EmbeddingService' | 'VectorStore',
): string {
  // Unwrap the R2 routing facade so the admin diag shows the real backend kind
  // (e.g. "sqlite-vec") instead of "routing-vector".
  const real = instance instanceof RoutingVectorStore ? instance.central : instance;
  return (
    real.constructor.name
      .replace(suffix, '')
      .replace(/([A-Z])/g, (_, c: string, i: number) => (i ? '-' : '') + c.toLowerCase())
      .replace(/^-/, '') || 'unknown'
  );
}
