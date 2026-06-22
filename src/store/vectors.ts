import type { VectorRecord, VectorMatch } from '@ctx/shared/types.js';
import type { ProviderStore } from './provider-store.js';
import { SqliteVecVectorStore, defaultSqliteVecPath } from './sqlite-vec-store.js';

/**
 * Abstraction over the vector database. Swapping Cloudflare Vectorize for
 * Qdrant, Pinecone or Bedrock+OpenSearch is a matter of implementing this
 * four-method surface. The factory `createVectorStore()` picks the concrete
 * class based on admin-managed configs (ProviderStore) with a legacy .env
 * fallback for backwards compatibility.
 */
export interface VectorStore {
  /**
   * Upsert records into `namespace` (code-per-project / docs-per-collection —
   * see `@ctx/shared/vector-namespace`). `undefined` = the shared/default
   * namespace (legacy behavior), so callers that don't namespace keep working.
   */
  upsert(records: VectorRecord[], namespace?: string): Promise<number>;
  search(
    queryVector: number[],
    options?: { topK?: number; filter?: Record<string, string>; namespace?: string }
  ): Promise<VectorMatch[]>;
  deleteByIds(ids: string[], namespace?: string): Promise<number>;
  /**
   * Drop EVERY vector in a namespace in one shot. Optional — only backends with
   * a native primitive implement it (sqlite-vec column delete, Qdrant
   * drop-collection, Pinecone delete-namespace). Backends without one (e.g.
   * Cloudflare Vectorize, which has no delete-by-metadata) omit it; callers
   * fall back to per-id `deleteByIds` using DB-tracked vector ids.
   */
  deleteNamespace?(namespace: string): Promise<number>;
  isAvailable(): Promise<boolean>;
}

export class CloudflareVectorStore implements VectorStore {
  private workerUrl: string;
  private authToken: string;
  // Vectorize enforces DIFFERENT per-request caps on upsert vs delete:
  //
  //   - upsert: ~1000 vectors per call (and a 10 MB body cap — usually
  //     the body limit hits first for high-dim vectors).
  //   - deleteByIds: hard cap of 100 ids per call (returns
  //     `VECTOR_DELETE_ERROR (code = 40007): too many ids in payload;
  //     max id count is 100`). Reported by the user as a 500 from the
  //     proxy Worker on a 534-id retry burst.
  //
  // Keeping a single `batchSize` for both meant any cleanup pass with
  // 100+ orphan vectors would crash. Two named constants make the
  // intent obvious and prevent a future "bump batch size to speed up
  // upsert" from re-introducing the delete bug.
  private upsertBatchSize = 1000;
  private deleteBatchSize = 100;

  constructor(workerUrl: string, authToken: string) {
    this.workerUrl = workerUrl.replace(/\/$/, '');
    this.authToken = authToken;
  }

  async upsert(records: VectorRecord[], namespace?: string): Promise<number> {
    if (records.length === 0) return 0;

    // Vectorize has no native namespaces; we stamp `namespace` into each
    // vector's metadata and filter on it at query time. Requires a metadata
    // index on `namespace` in Vectorize:
    //   wrangler vectorize create-metadata-index <index> --propertyName namespace --type string
    const stamped = namespace
      ? records.map((r) => ({ ...r, metadata: { ...r.metadata, namespace } }))
      : records;

    let totalCount = 0;

    for (let i = 0; i < stamped.length; i += this.upsertBatchSize) {
      const batch = stamped.slice(i, i + this.upsertBatchSize);

      const response = await fetch(`${this.workerUrl}/upsert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ vectors: batch }),
      });

      if (!response.ok) {
        throw new Error(`Vectorize upsert error: ${response.status} ${await response.text()}`);
      }

      const data = await response.json() as { count: number };
      totalCount += data.count;
    }

    return totalCount;
  }

  async search(
    queryVector: number[],
    options?: { topK?: number; filter?: Record<string, string>; namespace?: string }
  ): Promise<VectorMatch[]> {
    const filter = options?.namespace
      ? { ...(options.filter ?? {}), namespace: options.namespace }
      : options?.filter;
    const response = await fetch(`${this.workerUrl}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify({
        vector: queryVector,
        topK: options?.topK ?? 20,
        filter,
      }),
    });

    if (!response.ok) {
      throw new Error(`Vectorize search error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { matches: VectorMatch[] };
    return data.matches;
  }

  // Namespace is ignored: Vectorize ids are globally unique and it has no
  // delete-by-metadata, so per-id delete is the only path (callers pass
  // DB-tracked ids). No deleteNamespace() for the same reason.
  async deleteByIds(ids: string[], _namespace?: string): Promise<number> {
    if (ids.length === 0) return 0;

    let totalCount = 0;

    for (let i = 0; i < ids.length; i += this.deleteBatchSize) {
      const batch = ids.slice(i, i + this.deleteBatchSize);

      const response = await fetch(`${this.workerUrl}/delete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ ids: batch }),
      });

      if (!response.ok) {
        throw new Error(`Vectorize delete error: ${response.status} ${await response.text()}`);
      }

      const data = await response.json() as { count: number };
      totalCount += data.count;
    }

    return totalCount;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${this.workerUrl}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);
      if (!response.ok) return false;

      const data = await response.json() as { ok: boolean };
      return data.ok === true;
    } catch {
      return false;
    }
  }
}

/**
 * Qdrant adapter — lightweight, self-hosted option for local dev (`docker run
 * -p 6333:6333 qdrant/qdrant`). Talks to the REST API directly; no SDK dep.
 *
 * The collection is created lazily on the first upsert with a dimension
 * derived from the incoming vectors. If the collection already exists with a
 * different dimension the upsert fails loudly — callers should drop and
 * recreate via the admin UI.
 */
export class QdrantVectorStore implements VectorStore {
  private baseUrl: string;
  private apiKey?: string;
  private collection: string;
  private ensured = false;

  constructor(opts: { url: string; collection?: string; apiKey?: string }) {
    this.baseUrl = opts.url.replace(/\/$/, '');
    this.collection = opts.collection ?? 'mcp_code_index';
    this.apiKey = opts.apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['api-key'] = this.apiKey;
    return h;
  }

  private async ensureCollection(dim: number): Promise<void> {
    if (this.ensured) return;
    const check = await fetch(`${this.baseUrl}/collections/${this.collection}`, {
      headers: this.headers(),
    });
    if (check.status === 404) {
      const create = await fetch(`${this.baseUrl}/collections/${this.collection}`, {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({
          vectors: { size: dim, distance: 'Cosine' },
        }),
      });
      if (!create.ok) {
        throw new Error(`Qdrant create collection failed: ${create.status} ${await create.text()}`);
      }
    }
    this.ensured = true;
  }

  async upsert(records: VectorRecord[], namespace?: string): Promise<number> {
    if (records.length === 0) return 0;
    await this.ensureCollection(records[0].values.length);

    // Qdrant requires numeric or UUID ids. We keep the string id in the
    // payload and hash it to a stable u64 for the point id. The `namespace`
    // rides in the payload and is filtered/deleted natively — one collection,
    // no per-id-delete-needs-collection foot-gun.
    const points = records.map((r) => ({
      id: stableU64(r.id),
      vector: r.values,
      payload: { ...r.metadata, _id: r.id, ...(namespace ? { namespace } : {}) },
    }));

    const resp = await fetch(`${this.baseUrl}/collections/${this.collection}/points?wait=true`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ points }),
    });
    if (!resp.ok) {
      throw new Error(`Qdrant upsert failed: ${resp.status} ${await resp.text()}`);
    }
    return records.length;
  }

  async search(
    queryVector: number[],
    options?: { topK?: number; filter?: Record<string, string>; namespace?: string }
  ): Promise<VectorMatch[]> {
    const must: Array<{ key: string; match: { value: string } }> = [];
    if (options?.filter) {
      for (const [key, value] of Object.entries(options.filter)) must.push({ key, match: { value } });
    }
    if (options?.namespace) must.push({ key: 'namespace', match: { value: options.namespace } });
    const body: Record<string, unknown> = {
      vector: queryVector,
      limit: options?.topK ?? 20,
      with_payload: true,
    };
    if (must.length > 0) body.filter = { must };

    const resp = await fetch(`${this.baseUrl}/collections/${this.collection}/points/search`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Qdrant search failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as {
      result: Array<{ id: number | string; score: number; payload: Record<string, unknown> }>;
    };
    return data.result.map((r) => {
      const payload = r.payload ?? {};
      const stringId = (payload._id as string) ?? String(r.id);
      const meta: Record<string, string> = {};
      for (const [k, v] of Object.entries(payload)) {
        if (k === '_id') continue;
        if (v === null || v === undefined) continue;
        meta[k] = typeof v === 'string' ? v : String(v);
      }
      return { id: stringId, score: r.score, metadata: meta };
    });
  }

  // Point ids are globally unique within the collection, so per-id delete is
  // namespace-agnostic (unlike Pinecone where ids are namespace-scoped).
  async deleteByIds(ids: string[], _namespace?: string): Promise<number> {
    if (ids.length === 0) return 0;
    const points = ids.map((id) => stableU64(id));
    const resp = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points/delete?wait=true`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ points }),
      }
    );
    if (!resp.ok) {
      throw new Error(`Qdrant delete failed: ${resp.status} ${await resp.text()}`);
    }
    return ids.length;
  }

  /** Drop every point in a namespace via Qdrant's native filter-delete. */
  async deleteNamespace(namespace: string): Promise<number> {
    const resp = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points/delete?wait=true`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ filter: { must: [{ key: 'namespace', match: { value: namespace } }] } }),
      }
    );
    if (resp.status === 404) return 0;
    if (!resp.ok) {
      throw new Error(`Qdrant namespace delete failed: ${resp.status} ${await resp.text()}`);
    }
    return 1;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(`${this.baseUrl}/`, {
        headers: this.headers(),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return resp.ok;
    } catch {
      return false;
    }
  }
}

/**
 * OpenSearch adapter (managed service or Serverless) — canonical backend for
 * the Bedrock Titan embeddings path. Authenticates via AWS SigV4 using the
 * official `@opensearch-project/opensearch` client loaded dynamically so
 * users who don't need it don't pay the dep cost.
 *
 * The index is created lazily on first upsert with a k-NN mapping whose
 * `dimension` matches the incoming vectors (1024 for Titan v2, 768 for
 * BGE-M3). If the index already exists with a different dimension the
 * upsert fails — reindex requires dropping and recreating.
 */
interface OpenSearchClientShape {
  indices: {
    exists: (args: { index: string }) => Promise<{ statusCode: number }>;
    create: (args: { index: string; body: unknown }) => Promise<unknown>;
  };
  bulk: (args: { body: unknown[] }) => Promise<{ body: { errors: boolean; items: unknown[] } }>;
  search: (args: {
    index: string;
    body: unknown;
  }) => Promise<{
    body: { hits: { hits: Array<{ _id: string; _score: number; _source: Record<string, unknown> }> } };
  }>;
  delete: (args: { index: string; id: string }) => Promise<unknown>;
  deleteByQuery?: (args: { index: string; body: unknown }) => Promise<unknown>;
  ping: () => Promise<unknown>;
}

export class OpenSearchVectorStore implements VectorStore {
  private endpoint: string;
  private region: string;
  private indexName: string;
  private accessKeyId?: string;
  private secretAccessKey?: string;
  private sessionToken?: string;
  private serviceName: 'es' | 'aoss';
  private clientPromise: Promise<OpenSearchClientShape> | null = null;
  private ensured = false;

  constructor(opts: {
    endpoint: string;
    region: string;
    indexName?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    /** 'es' for OpenSearch Service, 'aoss' for Serverless. Affects SigV4 service name + supported ops. */
    serviceName?: 'es' | 'aoss';
  }) {
    this.endpoint = opts.endpoint.replace(/\/$/, '');
    this.region = opts.region;
    this.indexName = opts.indexName ?? 'mcp-code-index';
    this.accessKeyId = opts.accessKeyId;
    this.secretAccessKey = opts.secretAccessKey;
    this.sessionToken = opts.sessionToken;
    this.serviceName = opts.serviceName ?? 'aoss';
  }

  private async getClient(): Promise<OpenSearchClientShape> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        try {
          const modName = '@opensearch-project/opensearch';
          const awsModName = '@opensearch-project/opensearch/aws';
          const credProviderName = '@aws-sdk/credential-provider-node';
          const mod = (await import(/* @vite-ignore */ modName)) as {
            Client: new (opts: unknown) => OpenSearchClientShape;
          };
          const awsMod = (await import(/* @vite-ignore */ awsModName)) as {
            AwsSigv4Signer: (opts: unknown) => Record<string, unknown>;
          };

          // Credentials: explicit opts → default AWS provider chain
          // (env → shared config → ECS/EC2 metadata). Matching the Bedrock
          // provider's behavior so users set one set of creds in .env and
          // both services pick them up.
          const credentialsProvider = this.accessKeyId && this.secretAccessKey
            ? async () => ({
                accessKeyId: this.accessKeyId!,
                secretAccessKey: this.secretAccessKey!,
                sessionToken: this.sessionToken,
              })
            : (
                (await import(/* @vite-ignore */ credProviderName)) as {
                  defaultProvider: () => () => Promise<unknown>;
                }
              ).defaultProvider();

          return new mod.Client({
            ...awsMod.AwsSigv4Signer({
              region: this.region,
              service: this.serviceName,
              getCredentials: credentialsProvider,
            }),
            node: this.endpoint,
          });
        } catch (e) {
          throw new Error(
            `OpenSearch vector store requires @opensearch-project/opensearch and ` +
              `@aws-sdk/credential-provider-node. Install with: ` +
              `pnpm add @opensearch-project/opensearch @aws-sdk/credential-provider-node ` +
              `(${(e as Error).message})`
          );
        }
      })();
    }
    return this.clientPromise as Promise<OpenSearchClientShape>;
  }

  private async ensureIndex(dim: number): Promise<void> {
    if (this.ensured) return;
    const client = await this.getClient();
    try {
      const exists = await client.indices.exists({ index: this.indexName });
      if (exists.statusCode === 404) {
        await client.indices.create({
          index: this.indexName,
          body: {
            settings: { index: { knn: true } },
            mappings: {
              properties: {
                vector: {
                  type: 'knn_vector',
                  dimension: dim,
                  method: {
                    name: 'hnsw',
                    space_type: 'cosinesimil',
                    engine: 'nmslib',
                  },
                },
                project_name: { type: 'keyword' },
                type: { type: 'keyword' },
                ref_id: { type: 'keyword' },
                namespace: { type: 'keyword' },
              },
            },
          },
        });
      }
      this.ensured = true;
    } catch (e) {
      // On Serverless, `indices.exists` sometimes 403s when the index is
      // still being created — treat that as "probably fine, try again on
      // next call".
      console.error('[opensearch] ensureIndex failed:', (e as Error).message);
    }
  }

  async upsert(records: VectorRecord[], namespace?: string): Promise<number> {
    if (records.length === 0) return 0;
    await this.ensureIndex(records[0].values.length);
    const client = await this.getClient();

    // Bulk body: alternating action + document lines. We use `index` (not
    // `create`) so re-embedding overwrites the previous vector.
    const body: unknown[] = [];
    for (const r of records) {
      body.push({ index: { _index: this.indexName, _id: r.id } });
      body.push({ vector: r.values, ...r.metadata, ...(namespace ? { namespace } : {}) });
    }

    const resp = await client.bulk({ body });
    if (resp.body.errors) {
      throw new Error(`OpenSearch bulk upsert had errors: ${JSON.stringify(resp.body.items).slice(0, 500)}`);
    }
    return records.length;
  }

  async search(
    queryVector: number[],
    options?: { topK?: number; filter?: Record<string, string>; namespace?: string }
  ): Promise<VectorMatch[]> {
    const client = await this.getClient();
    const topK = options?.topK ?? 20;

    // k-NN query with optional boolean filter by project/type/namespace. We use
    // the filter inside the knn clause (post-filter pattern) because pre-filter
    // requires the `lucene` engine which isn't universally available.
    const effectiveFilter: Record<string, string> = { ...(options?.filter ?? {}) };
    if (options?.namespace) effectiveFilter.namespace = options.namespace;
    const knnQuery: Record<string, unknown> = { vector: queryVector, k: topK };
    if (Object.keys(effectiveFilter).length > 0) {
      knnQuery.filter = {
        bool: {
          must: Object.entries(effectiveFilter).map(([key, value]) => ({
            term: { [key]: value },
          })),
        },
      };
    }

    const resp = await client.search({
      index: this.indexName,
      body: {
        size: topK,
        query: { knn: { vector: knnQuery } },
      },
    });

    return resp.body.hits.hits.map((h) => {
      const src = h._source ?? {};
      const metadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(src)) {
        if (k === 'vector') continue;
        if (v === null || v === undefined) continue;
        metadata[k] = typeof v === 'string' ? v : String(v);
      }
      return { id: h._id, score: h._score, metadata };
    });
  }

  async deleteByIds(ids: string[], _namespace?: string): Promise<number> {
    if (ids.length === 0) return 0;
    const client = await this.getClient();
    // Serverless does not support `delete_by_query`; per-id delete is the
    // reliable path. Batched sequentially — order-sensitive anyway.
    let count = 0;
    for (const id of ids) {
      try {
        await client.delete({ index: this.indexName, id });
        count++;
      } catch {
        /* ignore individual miss — vector may already be gone */
      }
    }
    return count;
  }

  /**
   * Drop a namespace via delete_by_query on the `namespace` keyword. Only
   * available on managed OpenSearch ('es'); Serverless ('aoss') doesn't
   * support delete_by_query, so callers there fall back to per-id deleteByIds.
   */
  async deleteNamespace(namespace: string): Promise<number> {
    if (this.serviceName === 'aoss') {
      throw new Error('OpenSearch Serverless (aoss) has no delete_by_query; use deleteByIds');
    }
    const client = await this.getClient();
    if (!client.deleteByQuery) {
      throw new Error('OpenSearch client lacks deleteByQuery');
    }
    await client.deleteByQuery({
      index: this.indexName,
      body: { query: { term: { namespace } } },
    });
    return 1;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const client = await this.getClient();
      await client.ping();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Pinecone adapter — talks directly to the per-index host over REST (no SDK
 * dep). Pinecone serverless requires the fully-qualified index host URL
 * (e.g. `https://my-index-abcd123.svc.us-east-1-aws.pinecone.io`) which the
 * user gets from the Pinecone console after creating the index. The index
 * must already exist with the correct dimension/metric — unlike Qdrant and
 * OpenSearch we don't auto-create because Pinecone also requires the user to
 * pick a cloud/region pod tier, which is out of scope for this tool.
 *
 * Namespaces are used for multi-tenancy: the `namespace` option partitions
 * records within one index (empty string = default namespace).
 */
export class PineconeVectorStore implements VectorStore {
  private host: string;
  private apiKey: string;
  private namespace: string;

  constructor(opts: { host: string; apiKey: string; namespace?: string }) {
    this.host = opts.host.replace(/\/$/, '');
    // Pinecone expects the bare host; accept full URLs and strip the scheme.
    if (this.host.startsWith('http://') || this.host.startsWith('https://')) {
      // keep as-is — fetch handles both
    } else {
      this.host = `https://${this.host}`;
    }
    this.apiKey = opts.apiKey;
    this.namespace = opts.namespace ?? '';
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Api-Key': this.apiKey,
      'X-Pinecone-API-Version': '2025-01',
    };
  }

  /** Effective Pinecone namespace: the per-call namespace wins; the
   *  constructor namespace (if any) is kept as a prefix for shared indexes. */
  private ns(namespace?: string): string {
    if (!namespace) return this.namespace;
    return this.namespace ? `${this.namespace}__${namespace}` : namespace;
  }

  async upsert(records: VectorRecord[], namespace?: string): Promise<number> {
    if (records.length === 0) return 0;
    // Pinecone caps a single upsert request at 2MB / ~100 vectors for large
    // dims. Batch to 100 to stay well under the limit.
    const batchSize = 100;
    let total = 0;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const vectors = batch.map((r) => ({
        id: r.id,
        values: r.values,
        // Pinecone metadata must be flat (string|number|boolean|string[])
        metadata: r.metadata,
      }));
      const resp = await fetch(`${this.host}/vectors/upsert`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ vectors, namespace: this.ns(namespace) }),
      });
      if (!resp.ok) {
        throw new Error(`Pinecone upsert failed: ${resp.status} ${await resp.text()}`);
      }
      const data = (await resp.json()) as { upsertedCount?: number };
      total += data.upsertedCount ?? batch.length;
    }
    return total;
  }

  async search(
    queryVector: number[],
    options?: { topK?: number; filter?: Record<string, string>; namespace?: string }
  ): Promise<VectorMatch[]> {
    const body: Record<string, unknown> = {
      vector: queryVector,
      topK: options?.topK ?? 20,
      includeMetadata: true,
      includeValues: false,
      namespace: this.ns(options?.namespace),
    };
    if (options?.filter && Object.keys(options.filter).length > 0) {
      // Pinecone uses Mongo-style filter expressions: {field: {$eq: value}}.
      const filter: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(options.filter)) {
        filter[k] = { $eq: v };
      }
      body.filter = filter;
    }

    const resp = await fetch(`${this.host}/query`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Pinecone query failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as {
      matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }>;
    };
    return data.matches.map((m) => {
      const metadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(m.metadata ?? {})) {
        if (v === null || v === undefined) continue;
        metadata[k] = typeof v === 'string' ? v : String(v);
      }
      return { id: m.id, score: m.score, metadata };
    });
  }

  async deleteByIds(ids: string[], namespace?: string): Promise<number> {
    if (ids.length === 0) return 0;
    // Pinecone accepts up to 1000 ids per delete call.
    const batchSize = 1000;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const resp = await fetch(`${this.host}/vectors/delete`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ids: batch, namespace: this.ns(namespace) }),
      });
      if (!resp.ok) {
        throw new Error(`Pinecone delete failed: ${resp.status} ${await resp.text()}`);
      }
    }
    return ids.length;
  }

  /** Delete every vector in a namespace (Pinecone's native deleteAll). */
  async deleteNamespace(namespace: string): Promise<number> {
    const resp = await fetch(`${this.host}/vectors/delete`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ deleteAll: true, namespace: this.ns(namespace) }),
    });
    // 404 = namespace doesn't exist → nothing to delete.
    if (resp.status === 404) return 0;
    if (!resp.ok) {
      throw new Error(`Pinecone deleteAll failed: ${resp.status} ${await resp.text()}`);
    }
    return 1;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(`${this.host}/describe_index_stats`, {
        method: 'POST',
        headers: this.headers(),
        body: '{}',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return resp.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Deterministic string → u64 hash. Qdrant accepts either UUIDs or unsigned
 * integers as point ids; we hash the string id (e.g. "s_abc123") to a stable
 * 63-bit number so reindexing the same symbol updates the same point.
 */
function stableU64(s: string): number {
  // FNV-1a 64-bit folded to 53-bit safe integer (JS can't hold full u64).
  let h = BigInt('0xcbf29ce484222325');
  const prime = BigInt('0x100000001b3');
  const mask = BigInt('0xffffffffffffffff');
  for (let i = 0; i < s.length; i++) {
    h = ((h ^ BigInt(s.charCodeAt(i))) * prime) & mask;
  }
  // Clamp to Number.MAX_SAFE_INTEGER range.
  return Number(h & BigInt('0x1fffffffffffff'));
}

/**
 * Null vector store — used when no embedding config is active. Makes callers
 * unconditional (no null checks) and degrades search cleanly to FTS-only.
 */
export class NullVectorStore implements VectorStore {
  async upsert(_records: VectorRecord[]): Promise<number> {
    return 0;
  }
  async search(
    _q: number[],
    _opts?: { topK?: number; filter?: Record<string, string> }
  ): Promise<VectorMatch[]> {
    return [];
  }
  async deleteByIds(_ids: string[]): Promise<number> {
    return 0;
  }
  async isAvailable(): Promise<boolean> {
    return false;
  }
}

/**
 * Build a VectorStore from the admin-managed vector_store_configs table,
 * Priority:
 *   1. Row marked is_default=1, enabled=1 in provider_store.vector_store_configs
 *   2. NullVectorStore — search degrades to FTS-only
 *
 * Legacy .env vars are migrated into the ProviderStore via seedFromEnvIfEmpty()
 * at startup, so they are covered by case 1 after the first run.
 *
 * Returning `null` is no longer needed: callers should check isAvailable() or
 * instanceof NullVectorStore if they need to branch.
 */
export function createVectorStore(
  store: ProviderStore | null,
): VectorStore {
  if (store && typeof (store as unknown as { getDefaultVectorStore?: unknown }).getDefaultVectorStore === 'function') {
    const cfg = (store as unknown as { getDefaultVectorStore: () => { kind: string; config: Record<string, unknown> } | null }).getDefaultVectorStore();
    if (cfg) {
      if (cfg.kind === 'cloudflare') {
        const c = cfg.config as { workerUrl?: string; workerToken?: string };
        if (c.workerUrl) return new CloudflareVectorStore(c.workerUrl, c.workerToken ?? '');
      }
      if (cfg.kind === 'qdrant') {
        const c = cfg.config as { url?: string; collection?: string; apiKey?: string };
        if (c.url) return new QdrantVectorStore({ url: c.url, collection: c.collection, apiKey: c.apiKey });
      }
      if (cfg.kind === 'pinecone') {
        const c = cfg.config as { host?: string; apiKey?: string; namespace?: string };
        if (c.host && c.apiKey) {
          return new PineconeVectorStore({
            host: c.host,
            apiKey: c.apiKey,
            namespace: c.namespace,
          });
        }
      }
      if (cfg.kind === 'sqlite-vec') {
        const c = cfg.config as { path?: string };
        return new SqliteVecVectorStore({ path: c.path || defaultSqliteVecPath() });
      }
      if (cfg.kind === 'bedrock-opensearch') {
        const c = cfg.config as {
          endpoint?: string;
          region?: string;
          indexName?: string;
          accessKeyId?: string;
          secretAccessKey?: string;
          sessionToken?: string;
          serviceName?: 'es' | 'aoss';
        };
        if (c.endpoint && c.region) {
          return new OpenSearchVectorStore({
            endpoint: c.endpoint,
            region: c.region,
            indexName: c.indexName,
            accessKeyId: c.accessKeyId,
            secretAccessKey: c.secretAccessKey,
            sessionToken: c.sessionToken,
            serviceName: c.serviceName,
          });
        }
      }
    }
  }

  return new NullVectorStore();
}
