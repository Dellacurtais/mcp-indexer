import type { ProviderStore } from '@ctx/store/provider-store.js';
import { LocalEmbeddingService } from './local-embeddings.js';

export interface EmbeddingService {
  embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }>;
  embedQuery(text: string): Promise<{ vector: number[]; tokens: number }>;
  /**
   * Stable id of the model + backend (e.g. `cloudflare:bge-m3`,
   * `local:Xenova/multilingual-e5-small`). Optional so test fakes don't need
   * it; the indexer uses it to detect a model change and trigger a re-embed.
   */
  fingerprint?(): string;
  /**
   * How many `embed()` calls this backend tolerates in flight at once.
   * Optional hint consumed by the indexer's batch runner; absent → 1
   * (sequential). Network-bound backends benefit from > 1; a CPU-bound
   * single-session backend (local ONNX) must stay at 1.
   */
  maxConcurrency?(): number;
  /**
   * Release process-held resources (local ONNX sessions). Optional —
   * network backends and test fakes have nothing to free. Implementations
   * must tolerate further calls after dispose (lazy re-create).
   */
  dispose?(): Promise<void>;
}

export class CloudflareEmbeddingService implements EmbeddingService {
  private workerUrl: string;
  private authToken: string;
  private fetchFn: typeof fetch;
  private requestTimeoutMs: number;
  private batchSize = 100;
  /**
   * Conservative cap below the API's hard limit (60k). The estimator
   * `length / 4` works for English prose but underestimates by 30-50%
   * on technical docs (CamelCase, markdown code fences, non-ASCII).
   * Hitting `Max context reached 67200 tokens but model supports only
   * 60000` in the wild forced this down from the original 50k. With 35k
   * the estimator can be off by ~70% before we overflow — and even when
   * we do, `embedBatch` halves the batch and retries.
   */
  private maxBatchTokens = 35_000;
  private maxSingleTextTokens = 8192; // BGE-M3 max sequence length

  constructor(workerUrl: string, authToken: string, fetchFn: typeof fetch = fetch, requestTimeoutMs?: number) {
    this.workerUrl = workerUrl.replace(/\/$/, '');
    this.authToken = authToken;
    this.fetchFn = fetchFn;
    // 60s by default — env override lets ops tune without a redeploy.
    // The historical bug that motivated this was a Worker that held
    // TCP open but never responded; without an AbortController, the
    // outer `await` blocked forever. See Addendum 3 of the plan.
    const envTimeout = Number(process.env.MCP_EMBED_TIMEOUT_MS);
    this.requestTimeoutMs = requestTimeoutMs
      ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 60_000);
  }

  private async fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.requestTimeoutMs);
      let response: Response;
      try {
        response = await this.fetchFn(url, { ...init, signal: ctl.signal });
      } catch (err) {
        clearTimeout(timer);
        // AbortError = timeout fired. Treat as transient (network blip,
        // Cloudflare Worker degraded) and let the retry loop decide.
        const isAbort = isAbortError(err);
        if (isAbort && attempt < maxRetries) {
          const delay = Math.min(1000 * 2 ** attempt, 8000);
          console.warn(
            `[embeddings] request timed out after ${this.requestTimeoutMs}ms, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
          );
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        // Non-abort fetch error, or last attempt — surface with context.
        if (isAbort) {
          throw new Error(
            `Embedding API timeout: no response within ${this.requestTimeoutMs}ms after ${maxRetries + 1} attempts`,
          );
        }
        throw err;
      }
      clearTimeout(timer);
      if (response.ok) return response;

      // Read the body once so we can both detect non-retryable conditions
      // AND surface the message in the thrown error.
      const body = await response.text();

      // Cloudflare returns a 500 for "Max context reached" but it's a
      // deterministic body-too-large condition — retrying with the same
      // payload would just burn delay. `embedBatch` handles this by
      // splitting and retrying with smaller batches.
      if (isContextOverflowError(body)) {
        throw new Error(`Embedding API error: ${response.status} ${body}`);
      }

      // Only retry on 5xx (server/transient errors)
      if (response.status < 500 || attempt === maxRetries) {
        throw new Error(`Embedding API error: ${response.status} ${body}`);
      }

      const delay = Math.min(1000 * 2 ** attempt, 8000);
      console.warn(`[embeddings] API returned ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
    }
    throw new Error('Unreachable');
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private buildBatches(texts: string[]): string[][] {
    const batches: string[][] = [];
    let currentBatch: string[] = [];
    let currentTokens = 0;

    for (const text of texts) {
      let processed = text;
      if (this.estimateTokens(processed) > this.maxSingleTextTokens) {
        console.warn(`[embeddings] Single text exceeds ${this.maxSingleTextTokens} token limit, truncating (${this.estimateTokens(processed)} est. tokens)`);
        processed = processed.slice(0, this.maxSingleTextTokens * 4);
      }

      const textTokens = this.estimateTokens(processed);

      if (currentBatch.length > 0 &&
          (currentTokens + textTokens > this.maxBatchTokens || currentBatch.length >= this.batchSize)) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }

      currentBatch.push(processed);
      currentTokens += textTokens;
    }

    if (currentBatch.length > 0) batches.push(currentBatch);
    return batches;
  }

  /**
   * Send one batch to the embedding API. If the API rejects the batch
   * with "Max context reached" (the token estimator underestimated),
   * recursively split the batch in half and retry each half. Termination:
   * a single-text batch can't be split, so we propagate the error — but
   * that's vanishingly rare in practice (`maxSingleTextTokens=8192`
   * means a single text can't push us anywhere near 60k).
   */
  private async embedBatch(batch: string[]): Promise<number[][]> {
    if (batch.length === 0) return [];
    try {
      const response = await this.fetchWithRetry(`${this.workerUrl}/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ texts: batch }),
      });
      const data = await response.json() as { vectors: number[][]; count: number };
      return data.vectors;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isContextOverflowError(msg) && batch.length > 1) {
        const mid = Math.floor(batch.length / 2);
        console.warn(
          `[embeddings] context overflow on batch of ${batch.length}; splitting and retrying (${mid} + ${batch.length - mid})`,
        );
        const left = await this.embedBatch(batch.slice(0, mid));
        const right = await this.embedBatch(batch.slice(mid));
        return [...left, ...right];
      }
      throw err;
    }
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };

    const allVectors: number[][] = [];
    let totalTokens = 0;
    const batches = this.buildBatches(texts);

    for (const batch of batches) {
      const vectors = await this.embedBatch(batch);
      allVectors.push(...vectors);
      totalTokens += batch.reduce((sum, t) => sum + this.estimateTokens(t), 0);
    }

    return { vectors: allVectors, tokens: totalTokens };
  }

  async embedQuery(text: string): Promise<{ vector: number[]; tokens: number }> {
    const result = await this.embed([text]);
    return {
      vector: result.vectors[0] ?? [],
      tokens: result.tokens,
    };
  }

  fingerprint(): string {
    // The Worker pins @cf/baai/bge-m3 (1024-d), so the URL/token don't change
    // the vector space — the model identity is what matters for re-index.
    return 'cloudflare:bge-m3';
  }

  maxConcurrency(): number {
    // Judgment call, not a measured limit — Workers AI rate limits for
    // bge-m3 aren't published. 4 in-flight requests of ≤35k est. tokens is
    // modest; `fetchWithRetry` absorbs transient 429/5xx per request, and
    // MCP_EMBED_CONCURRENCY=1 restores sequential behavior.
    return 4;
  }
}

/**
 * Recognize Cloudflare's response when a batch crosses the model's
 * context window. The canonical payload is:
 *
 *   {"error":"3030: Max context reached 67200 tokens but model supports only 60000"}
 *
 * The 3030 error code is stable but we match on the human phrase too —
 * cheap defense against minor format changes upstream.
 */
function isContextOverflowError(text: string): boolean {
  if (!text) return false;
  return text.includes('Max context reached') || text.includes('"3030:');
}

/**
 * Recognize the AbortError that `AbortController.abort()` raises through
 * `fetch`. Node's undici uses `DOMException` with `name === 'AbortError'`;
 * some test stubs / polyfills throw plain `Error('aborted')`. Match both.
 */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  return /aborted|abort/i.test(err.message);
}

/**
 * Amazon Bedrock Titan embeddings. Supports both v1 (amazon.titan-embed-text-v1,
 * 1536 dims) and v2 (amazon.titan-embed-text-v2:0, 1024 dims — default).
 *
 * The AWS SDK is loaded via dynamic import so users who don't use Bedrock
 * don't need to pull in @aws-sdk/client-bedrock-runtime (≈10MB). If the dep
 * is missing the constructor throws with an actionable error.
 *
 * Bedrock doesn't accept batch requests for Titan embeddings — each text
 * costs one InvokeModel call. This is the reality, not a limitation of this
 * wrapper; the indexer caller batches at a higher level and amortizes.
 */
export class BedrockTitanEmbeddingService implements EmbeddingService {
  private region: string;
  private modelId: string;
  private accessKeyId: string;
  private secretAccessKey: string;
  private sessionToken?: string;
  private requestTimeoutMs: number;
  private clientPromise: Promise<unknown> | null = null;

  constructor(opts: {
    region: string;
    modelId?: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    requestTimeoutMs?: number;
  }) {
    this.region = opts.region;
    this.modelId = opts.modelId ?? 'amazon.titan-embed-text-v2:0';
    this.accessKeyId = opts.accessKeyId;
    this.secretAccessKey = opts.secretAccessKey;
    this.sessionToken = opts.sessionToken;
    const envTimeout = Number(process.env.MCP_EMBED_TIMEOUT_MS);
    this.requestTimeoutMs = opts.requestTimeoutMs
      ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 60_000);
  }

  private async getClient(): Promise<{
    client: { send: (cmd: unknown) => Promise<{ body: Uint8Array }> };
    Command: new (input: { modelId: string; contentType: string; accept: string; body: Uint8Array }) => unknown;
  }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        try {
          // Dynamic via variable so TypeScript doesn't require the types to
          // be present at build time. The dep is optional.
          const modName = '@aws-sdk/client-bedrock-runtime';
          const mod = (await import(/* @vite-ignore */ modName)) as {
            BedrockRuntimeClient: new (cfg: unknown) => { send: (cmd: unknown) => Promise<{ body: Uint8Array }> };
            InvokeModelCommand: new (input: unknown) => unknown;
          };
          // Use the SDK's built-in request timeout. Bedrock doesn't fall
          // back to a default — without this the SDK can hang on a stuck
          // socket, same failure mode as the original Cloudflare bug. We
          // shape it like the @smithy/node-http-handler config; older
          // SDK versions accept it via `requestHandler` too.
          // Cast to `unknown` first — `BedrockRuntimeClient`'s constructor
          // is typed too loosely to satisfy `Parameters<typeof Class>[0]`.
          const clientCfg = {
            region: this.region,
            credentials: {
              accessKeyId: this.accessKeyId,
              secretAccessKey: this.secretAccessKey,
              sessionToken: this.sessionToken,
            },
            requestHandler: {
              requestTimeout: this.requestTimeoutMs,
              connectionTimeout: Math.min(10_000, this.requestTimeoutMs),
            },
          };
          const client = new mod.BedrockRuntimeClient(clientCfg);
          return { client, Command: mod.InvokeModelCommand as unknown as { new (input: { modelId: string; contentType: string; accept: string; body: Uint8Array }): unknown } };
        } catch (e) {
          throw new Error(
            `Bedrock Titan embeddings require @aws-sdk/client-bedrock-runtime. ` +
              `Install it with: pnpm add @aws-sdk/client-bedrock-runtime (${(e as Error).message})`
          );
        }
      })();
    }
    return this.clientPromise as Promise<{
      client: { send: (cmd: unknown) => Promise<{ body: Uint8Array }> };
      Command: new (input: { modelId: string; contentType: string; accept: string; body: Uint8Array }) => unknown;
    }>;
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    const { client, Command } = await this.getClient();
    const vectors: number[][] = [];
    let totalTokens = 0;
    for (const text of texts) {
      const body = new TextEncoder().encode(JSON.stringify({ inputText: text }));
      const cmd = new Command({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body,
      });
      const resp = await client.send(cmd);
      const parsed = JSON.parse(new TextDecoder().decode(resp.body)) as {
        embedding: number[];
        inputTextTokenCount?: number;
      };
      vectors.push(parsed.embedding);
      totalTokens += parsed.inputTextTokenCount ?? Math.ceil(text.length / 4);
    }
    return { vectors, tokens: totalTokens };
  }

  async embedQuery(text: string): Promise<{ vector: number[]; tokens: number }> {
    const r = await this.embed([text]);
    return { vector: r.vectors[0] ?? [], tokens: r.tokens };
  }

  fingerprint(): string {
    return `bedrock:${this.modelId}`;
  }

  maxConcurrency(): number {
    // Titan is per-text InvokeModel; account-level TPS limits are real but
    // unverified — stay conservative. Tunable via MCP_EMBED_CONCURRENCY.
    return 2;
  }
}

export class NullEmbeddingService implements EmbeddingService {
  async embed(_texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    return { vectors: [], tokens: 0 };
  }

  async embedQuery(_text: string): Promise<{ vector: number[]; tokens: number }> {
    return { vector: [], tokens: 0 };
  }

  fingerprint(): string {
    return 'null';
  }
}

/**
 * Build an EmbeddingService from the admin-managed embedding_configs table.
 * Priority:
 *   1. Row marked is_default=1 and enabled=1 in provider_store.
 *   2. NullEmbeddingService (no embeddings, search falls back to FTS-only).
 *
 * Legacy .env vars (MCP_INDEX_WORKER_URL/TOKEN) are migrated into the
 * ProviderStore via seedFromEnvIfEmpty() at startup, so they are covered
 * by case 1 after the first run.
 *
 * The function is sync — it only queries SQLite via better-sqlite3 which is
 * synchronous — so callers don't need await.
 */
export function createEmbeddingService(
  store: ProviderStore | null,
): EmbeddingService {
  if (store) {
    const cfg = store.getDefaultEmbedding();
    if (cfg) {
      if (cfg.kind === 'cloudflare') {
        const c = cfg.config as { workerUrl?: string; workerToken?: string };
        if (c.workerUrl) return new CloudflareEmbeddingService(c.workerUrl, c.workerToken ?? '');
      }
      if (cfg.kind === 'bedrock') {
        const c = cfg.config as {
          region?: string;
          modelId?: string;
          accessKeyId?: string;
          secretAccessKey?: string;
          sessionToken?: string;
        };
        if (c.region && c.accessKeyId && c.secretAccessKey) {
          return new BedrockTitanEmbeddingService({
            region: c.region,
            modelId: c.modelId,
            accessKeyId: c.accessKeyId,
            secretAccessKey: c.secretAccessKey,
            sessionToken: c.sessionToken,
          });
        }
      }
      if (cfg.kind === 'local') {
        const c = cfg.config as { model?: string; cacheDir?: string };
        return new LocalEmbeddingService({ model: c.model, cacheDir: c.cacheDir });
      }
    }
  }

  return new NullEmbeddingService();
}
