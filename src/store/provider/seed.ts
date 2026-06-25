import type { Database as DB } from 'better-sqlite3';
import * as embedding from './embedding.js';
import * as vectorStore from './vector-store.js';
import * as reranker from './reranker.js';

/**
 * Seed the retrieval-only defaults from env. The upstream LLM-provider seeding
 * (which depended on the provider registry) is intentionally removed here — the
 * code-context server is retrieval-only and needs no chat/LLM provider. Only
 * embedding / vector-store and reranker defaults are seeded from env. Idempotent.
 */
export function seedFromEnvIfEmpty(db: DB): void {
  const env = process.env;
  seedEmbeddingAndVectorStore(db, env);
  seedReranker(db, env);
}

/**
 * Seed a reranker config from legacy env vars so existing deployments that
 * set COHERE_API_KEY or MCP_RERANK_WORKER_URL get an admin-visible, enabled
 * default without manual setup. Cohere wins when both are present (it doesn't
 * depend on the indexer Worker being reachable). No-op when neither is set —
 * `createReranker()` then yields a NullReranker (RRF-only, prior behavior).
 */
function seedReranker(db: DB, env: NodeJS.ProcessEnv): void {
  if (reranker.list(db).length > 0) return; // operator already configured one

  if (env.COHERE_API_KEY) {
    reranker.upsert(db, {
      id: 'cohere',
      kind: 'cohere',
      name: 'Cohere Rerank',
      enabled: true,
      is_default: true,
      config: {
        apiKey: env.COHERE_API_KEY,
        model: env.COHERE_RERANK_MODEL ?? 'rerank-v3.5',
      },
    });
    return;
  }

  // Only an explicit MCP_RERANK_WORKER_URL auto-enables — we deliberately do
  // NOT reuse MCP_INDEX_WORKER_URL here, so existing installs don't silently
  // gain per-query rerank latency/cost. The admin UI is the easy opt-in and
  // pre-fills this URL from the embedding/vector config.
  if (env.MCP_RERANK_WORKER_URL) {
    reranker.upsert(db, {
      id: 'cloudflare',
      kind: 'cloudflare',
      name: 'Cloudflare Reranker',
      enabled: true,
      is_default: true,
      config: {
        workerUrl: env.MCP_RERANK_WORKER_URL,
        workerToken: env.MCP_RERANK_WORKER_TOKEN ?? env.MCP_INDEX_WORKER_TOKEN ?? '',
      },
    });
    return;
  }

  // Desktop default: no paid/online reranker keys present. Seed the local
  // ONNX cross-encoder (transformers.js, offline, zero per-query cost) as the
  // enabled default. Without ANY reranker, `mode='hybrid'` is measurably worse
  // than FTS on code queries (R@5 0.64 vs 0.80 — see http-api/server/deps.ts),
  // so an offline reranker is the highest-leverage default for a desktop IDE.
  // The model downloads lazily on first use into MCP_MODEL_CACHE_DIR.
  reranker.upsert(db, {
    id: 'local',
    kind: 'local',
    name: 'Local Reranker (offline)',
    enabled: true,
    is_default: true,
    config: { model: 'Xenova/bge-reranker-base' },
  });
}

function seedEmbeddingAndVectorStore(db: DB, env: NodeJS.ProcessEnv): void {
  // Seed Cloudflare embedding config if worker URL is present in env.
  if (env.MCP_INDEX_WORKER_URL) {
    embedding.upsert(db, {
      id: 'cloudflare',
      kind: 'cloudflare',
      name: 'Cloudflare Vectorize',
      enabled: true,
      is_default: true,
      config: {
        workerUrl: env.MCP_INDEX_WORKER_URL,
        workerToken: env.MCP_INDEX_WORKER_TOKEN ?? '',
        // The embed worker hardcodes @cf/baai/bge-m3 (1024-dim, multilingual)
        // and ignores this `model` field (see worker/src/index.ts handleEmbed).
        // Record the TRUTH so the admin panel and /api/docs/vectors/diagnose
        // don't claim English-only 768-dim embeddings. The env override stays
        // for operators running a customized embed worker.
        model: env.MCP_INDEX_EMBEDDINGS_MODEL ?? '@cf/baai/bge-m3',
        dimensions: 1024,
      },
    });

    // Mirror to vector_store_configs so a fresh install with only legacy .env
    // has a default vector backend visible in the admin UI.
    if (vectorStore.list(db).length === 0) {
      vectorStore.upsert(db, {
        id: 'cloudflare',
        kind: 'cloudflare',
        name: 'Cloudflare Vectorize',
        enabled: true,
        is_default: true,
        config: {
          workerUrl: env.MCP_INDEX_WORKER_URL,
          workerToken: env.MCP_INDEX_WORKER_TOKEN ?? '',
        },
      });
    }
  }

  // Bedrock Titan embeddings (PAID; opt in with MCP_EMBEDDINGS=bedrock + AWS creds).
  // 1024-dim by default — switching from local ONNX (384-dim) needs a re-index.
  if (
    env.MCP_EMBEDDINGS?.trim().toLowerCase() === 'bedrock' &&
    env.AWS_REGION && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY &&
    !embedding.list(db).some((c) => c.id === 'bedrock')
  ) {
    embedding.upsert(db, {
      id: 'bedrock',
      kind: 'bedrock',
      name: 'AWS Bedrock Titan',
      enabled: true,
      is_default: true,
      config: {
        region: env.AWS_REGION,
        modelId: env.CODE_CONTEXT_EMBED_MODEL ?? 'amazon.titan-embed-text-v2:0',
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
        dimensions: 1024,
      },
    });
  }

  if (env.QDRANT_URL && !vectorStore.list(db).some((c) => c.id === 'qdrant')) {
    const hasOther = vectorStore.list(db).some((c) => c.is_default);
    vectorStore.upsert(db, {
      id: 'qdrant',
      kind: 'qdrant',
      name: 'Qdrant',
      enabled: true,
      is_default: !hasOther,
      config: {
        url: env.QDRANT_URL,
        collection: env.QDRANT_COLLECTION ?? 'mcp_code_index',
        apiKey: env.QDRANT_API_KEY ?? '',
      },
    });
  }

  if (
    env.PINECONE_HOST &&
    env.PINECONE_API_KEY &&
    !vectorStore.list(db).some((c) => c.id === 'pinecone')
  ) {
    const hasOther = vectorStore.list(db).some((c) => c.is_default);
    vectorStore.upsert(db, {
      id: 'pinecone',
      kind: 'pinecone',
      name: 'Pinecone',
      enabled: true,
      is_default: !hasOther,
      config: {
        host: env.PINECONE_HOST,
        apiKey: env.PINECONE_API_KEY,
        namespace: env.PINECONE_NAMESPACE ?? '',
      },
    });
  }

  // Seed Bedrock OpenSearch if OPENSEARCH_ENDPOINT is set. Uses AWS_REGION +
  // AWS credentials from the same env the Bedrock embedding provider reads.
  if (
    env.OPENSEARCH_ENDPOINT &&
    env.AWS_REGION &&
    !vectorStore.list(db).some((c) => c.id === 'bedrock-opensearch')
  ) {
    const hasOther = vectorStore.list(db).some((c) => c.is_default);
    vectorStore.upsert(db, {
      id: 'bedrock-opensearch',
      kind: 'bedrock-opensearch',
      name: 'Bedrock + OpenSearch',
      enabled: true,
      is_default: !hasOther,
      config: {
        endpoint: env.OPENSEARCH_ENDPOINT,
        region: env.AWS_REGION,
        indexName: env.OPENSEARCH_INDEX ?? 'mcp-code-index',
        serviceName: (env.OPENSEARCH_SERVICE as 'es' | 'aoss' | undefined) ?? 'aoss',
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
      },
    });
  }
}
