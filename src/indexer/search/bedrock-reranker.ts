/**
 * AWS Bedrock cross-encoder reranker, via the Bedrock Agent Runtime `Rerank` API
 * (amazon.rerank-v1:0, cohere.rerank-v3-5:0, …). Separate module so the @aws-sdk
 * dynamic import stays isolated (mirrors ./local-reranker.ts).
 *
 * NOTE: reranking runs on EVERY search, so a network backend adds latency + a
 * per-query Bedrock cost to each query. Prefer the local ONNX reranker unless you
 * specifically want Bedrock-grade precision. Opt in with CODE_CONTEXT_RERANK=bedrock.
 *
 * The Rerank operation lives in `@aws-sdk/client-bedrock-agent-runtime` (NOT
 * client-bedrock-runtime). Credentials resolve from explicit opts, then the SDK's
 * default chain (env AWS_*, ~/.aws, instance role).
 */
import type { RerankCandidate, RerankResult, RerankerService } from './reranker-types.js';

interface RerankClient {
  send: (cmd: unknown) => Promise<{ results?: Array<{ index?: number; relevanceScore?: number }> }>;
}
interface BedrockAgentSdk {
  BedrockAgentRuntimeClient: new (cfg: unknown) => RerankClient;
  RerankCommand: new (input: unknown) => unknown;
}

const MAX_TEXT = 4000; // char cap per query/document sent to the rerank model

export class BedrockReranker implements RerankerService {
  readonly name = 'bedrock';
  private region: string;
  private modelArn: string;
  private credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  private clientPromise: Promise<{ client: RerankClient; sdk: BedrockAgentSdk }> | null = null;

  constructor(opts: {
    model?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  }) {
    this.region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
    const model = opts.model ?? 'amazon.rerank-v1:0';
    // Accept a bare model id (build the foundation-model ARN) or a full ARN
    // (inference-profile / cross-region) passed verbatim.
    this.modelArn = model.startsWith('arn:')
      ? model
      : `arn:aws:bedrock:${this.region}::foundation-model/${model}`;
    if (opts.accessKeyId && opts.secretAccessKey) {
      this.credentials = {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        sessionToken: opts.sessionToken,
      };
    }
  }

  private async getClient(): Promise<{ client: RerankClient; sdk: BedrockAgentSdk }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        let sdk: BedrockAgentSdk;
        try {
          const modName = '@aws-sdk/client-bedrock-agent-runtime';
          sdk = (await import(/* @vite-ignore */ modName)) as unknown as BedrockAgentSdk;
        } catch (e) {
          throw new Error(
            'Bedrock reranker requires @aws-sdk/client-bedrock-agent-runtime. Install with: ' +
              `pnpm add @aws-sdk/client-bedrock-agent-runtime (${(e as Error).message})`,
          );
        }
        const client = new sdk.BedrockAgentRuntimeClient({ region: this.region, credentials: this.credentials });
        return { client, sdk };
      })();
    }
    return this.clientPromise;
  }

  async rerank(query: string, candidates: RerankCandidate[], topK = 10): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    const fallback = (): RerankResult[] =>
      candidates.slice(0, topK).map((c) => ({ id: c.id, score: c.originalScore, originalScore: c.originalScore }));

    try {
      const { client, sdk } = await this.getClient();
      const cmd = new sdk.RerankCommand({
        queries: [{ type: 'TEXT', textQuery: { text: query.slice(0, MAX_TEXT) } }],
        sources: candidates.map((c) => ({
          type: 'INLINE',
          inlineDocumentSource: { type: 'TEXT', textDocument: { text: c.text.slice(0, MAX_TEXT) } },
        })),
        rerankingConfiguration: {
          type: 'BEDROCK_RERANKING_MODEL',
          bedrockRerankingConfiguration: {
            numberOfResults: Math.min(topK, candidates.length),
            modelConfiguration: { modelArn: this.modelArn },
          },
        },
      });
      const resp = await client.send(cmd);
      const results = resp.results ?? [];
      if (results.length === 0) return fallback();
      return results.slice(0, topK).map((r) => {
        const c = candidates[r.index ?? 0] ?? candidates[0];
        return { id: c.id, score: r.relevanceScore ?? c.originalScore, originalScore: c.originalScore };
      });
    } catch (e) {
      // Graceful fallback to RRF order — never let a rerank failure break search.
      console.error(`[reranker] Bedrock rerank failed: ${e instanceof Error ? e.message : String(e)}`);
      return fallback();
    }
  }
}
