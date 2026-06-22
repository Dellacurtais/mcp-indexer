/**
 * Local, in-process cross-encoder reranker via transformers.js (ONNX/wasm) —
 * no network, no Cloudflare/Cohere round-trip, no per-query cost. The point
 * for a desktop IDE: calibrated reranking that works fully offline.
 *
 * Why this matters: without a reranker, `mode='hybrid'` is measurably WORSE
 * than plain FTS on code queries (R@5 0.64 vs 0.80 — see the note in
 * apps/http-api/server/deps.ts). A cross-encoder scores (query, passage)
 * pairs jointly, which sharply lifts precision on the RRF-merged top-N.
 *
 * Default model is `Xenova/bge-reranker-base` — multilingual enough for PT-BR
 * comments + English code identifiers. A lighter alternative is
 * `mixedbread-ai/mxbai-rerank-xsmall-v1` (set via `config.model`).
 *
 * `@huggingface/transformers` is imported lazily on first use so the (heavy)
 * ONNX runtime only loads when local reranking is actually selected — exactly
 * mirroring `LocalEmbeddingService` in ./local-embeddings.ts.
 */
import { createIdleResource, type IdleResource } from '@ctx/shared/utils/idle-disposer.js';
import type { RerankCandidate, RerankResult, RerankerService } from './reranker-types.js';
import { resolveModelCacheDir } from './model-cache.js';
import { resolveOnnxIdleTtlMs } from './onnx-idle.js';

const DEFAULT_MODEL = 'Xenova/bge-reranker-base';
const BATCH = 16;

/** Minimal shape of the transformers.js tokenizer call we rely on. */
type Tokenizer = (
  texts: string[],
  opts: { text_pair: string[]; padding: boolean; truncation: boolean },
) => Record<string, unknown>;

/** Minimal shape of the sequence-classification model call. */
type SeqClassModel = ((inputs: Record<string, unknown>) => Promise<{
  logits: { tolist: () => number[][] };
}>) & {
  /** Releases the underlying ONNX session(s). The tokenizer is plain JS (GC). */
  dispose(): Promise<unknown>;
};

interface CrossEncoder {
  tokenizer: Tokenizer;
  model: SeqClassModel;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Order-preserving fallback used on any failure (same contract as the other rerankers). */
function passthrough(candidates: RerankCandidate[], topK: number): RerankResult[] {
  return candidates.slice(0, topK).map((c) => ({
    id: c.id,
    score: c.originalScore,
    originalScore: c.originalScore,
  }));
}

export class LocalReranker implements RerankerService {
  readonly name = 'local';
  private model: string;
  private cacheDir?: string;
  private lease: IdleResource<CrossEncoder>;

  constructor(opts?: { model?: string; cacheDir?: string; idleTtlMs?: number }) {
    this.model = opts?.model || DEFAULT_MODEL;
    // Only the explicit admin override is stored here; the auto default
    // (~/.mcp/models) is resolved lazily at load time via resolveModelCacheDir.
    this.cacheDir = opts?.cacheDir;
    // bge-reranker-base is the biggest local model (~250MB+) — the idle
    // lease evicts it after a quiet period instead of pinning it for the
    // whole desktop session. `acquire` refcounts; no dispose mid-inference.
    this.lease = createIdleResource<CrossEncoder>({
      name: `local-reranker(${this.model})`,
      idleTtlMs: resolveOnnxIdleTtlMs(opts?.idleTtlMs),
      create: () => this.loadEncoder(),
      destroy: async (enc) => { await enc.model.dispose(); },
    });
  }

  private async loadEncoder(): Promise<CrossEncoder> {
    let mod: {
      AutoTokenizer: { from_pretrained: (m: string) => Promise<unknown> };
      AutoModelForSequenceClassification: { from_pretrained: (m: string) => Promise<unknown> };
      env?: Record<string, unknown>;
    };
    try {
      const modName = '@huggingface/transformers';
      mod = (await import(/* @vite-ignore */ modName)) as typeof mod;
    } catch (e) {
      throw new Error(
        `Local reranking requires @huggingface/transformers. ` +
          `Install it with: pnpm add @huggingface/transformers (${(e as Error).message})`,
      );
    }
    // Auto-resolve (and create) ~/.mcp/models unless overridden. No env
    // var or manual folder setup required.
    if (mod.env) (mod.env as { cacheDir?: string }).cacheDir = resolveModelCacheDir(this.cacheDir);
    const [tokenizer, model] = await Promise.all([
      mod.AutoTokenizer.from_pretrained(this.model),
      mod.AutoModelForSequenceClassification.from_pretrained(this.model),
    ]);
    return { tokenizer: tokenizer as Tokenizer, model: model as SeqClassModel };
  }

  /**
   * Score each candidate against the query with a cross-encoder, then return
   * the top-K sorted by score descending. Degrades to RRF order on any error
   * so a missing/incompatible model never breaks search.
   */
  async rerank(query: string, candidates: RerankCandidate[], topK = 10): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];

    try {
      // The whole scoring loop runs inside ONE acquire — eviction can never
      // strike between batches of the same rerank() call.
      return await this.lease.acquire(async (encoder) => {
        const scored: RerankResult[] = [];
        for (let i = 0; i < candidates.length; i += BATCH) {
          const batch = candidates.slice(i, i + BATCH);
          const inputs = encoder.tokenizer(
            batch.map(() => query),
            { text_pair: batch.map((c) => c.text), padding: true, truncation: true },
          );
          const { logits } = await encoder.model(inputs);
          const rows = logits.tolist();
          for (let j = 0; j < batch.length; j++) {
            // bge-reranker emits a single relevance logit per pair; sigmoid → 0-1.
            const logit = rows[j]?.[0] ?? 0;
            scored.push({
              id: batch[j].id,
              score: sigmoid(logit),
              originalScore: batch[j].originalScore,
            });
          }
        }
        return scored.sort((a, b) => b.score - a.score).slice(0, topK);
      });
    } catch (e) {
      // Load failure or inference failure — same passthrough contract.
      console.error(`[reranker] local rerank failed: ${(e as Error).message}`);
      return passthrough(candidates, topK);
    }
  }

  /** Release the ONNX session now (shutdown). The next rerank reloads lazily. */
  async dispose(): Promise<void> {
    await this.lease.dispose();
  }
}
