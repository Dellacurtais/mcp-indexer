/**
 * Namespace-routing VectorStore facade (R2 routing flip).
 *
 * Wraps the central vector store and the CodeIndexDB. Every op is routed purely
 * by its `namespace` argument:
 *   - `code:<project>`  → that project's own vectors.db (when migrated + the
 *                         MCP_PROJECT_DB_VECTORS flag is on + the backend is the
 *                         embedded sqlite-vec store), via db.codeVectorStoreFor.
 *   - everything else   → the central store. This deliberately keeps DOC vectors
 *                         (`docs:c<id>`) AND snapshot vectors (whose upsert/
 *                         search/delete carry NO namespace) wholly central.
 *
 * Routing is keyed by (namespace→projectName→projectId), and db.codeVectorStoreFor
 * caches the per-project store by projectId, so a search facade and a write
 * facade for the same project always resolve to the SAME underlying store — code
 * search and re-embed can never diverge.
 *
 * Installed by createSearchBundle ONLY when the flag is on; flag-off never wraps,
 * so the central store is used exactly as today (byte-identical).
 */
import type { VectorRecord, VectorMatch } from '@ctx/shared/types.js';
import type { CodeIndexDB } from './db.js';
import type { VectorStore } from './vectors.js';

const CODE_PREFIX = 'code:';

export class RoutingVectorStore implements VectorStore {
  constructor(
    /** The central store — also the diag/kind source (see search-bundle). */
    readonly central: VectorStore,
    private readonly db: CodeIndexDB,
  ) {}

  /** Resolve the store for a namespace: per-project for `code:<name>`, else central. */
  private route(namespace?: string): VectorStore {
    if (!namespace || !namespace.startsWith(CODE_PREFIX)) return this.central;
    const name = namespace.slice(CODE_PREFIX.length);
    const project = this.db.getProjectByName(name);
    if (!project) return this.central;
    return this.db.codeVectorStoreFor(project.id, this.central) ?? this.central;
  }

  upsert(records: VectorRecord[], namespace?: string): Promise<number> {
    return this.route(namespace).upsert(records, namespace);
  }

  search(
    queryVector: number[],
    options?: { topK?: number; filter?: Record<string, string>; namespace?: string },
  ): Promise<VectorMatch[]> {
    return this.route(options?.namespace).search(queryVector, options);
  }

  deleteByIds(ids: string[], namespace?: string): Promise<number> {
    return this.route(namespace).deleteByIds(ids, namespace);
  }

  deleteNamespace(namespace: string): Promise<number> {
    const store = this.route(namespace);
    return store.deleteNamespace ? store.deleteNamespace(namespace) : Promise.resolve(0);
  }

  isAvailable(): Promise<boolean> {
    return this.central.isAvailable();
  }
}
