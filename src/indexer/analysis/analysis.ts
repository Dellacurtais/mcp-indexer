/**
 * Optional LLM enrichment provider — text generation for file summaries, concept
 * tags and layer classification. Mirrors the embeddings provider pattern: the
 * @aws-sdk is a dynamic import (zero footprint when unused) and the whole feature
 * is off unless explicitly configured (`code-context enrich`).
 *
 * Bedrock uses the Converse API (one adapter works for Titan, Nova, Claude, Llama,
 * …). Inference-profile-only models (Nova, newer Claude) need a region prefix
 * (`us.` / `eu.` / `apac.`) — pass the full id (e.g. `us.amazon.nova-lite-v1:0`)
 * or set `inference: true` to have it prepended from the region.
 */
import type { FileLayer } from '@ctx/shared/types.js';
import type { ProviderStore } from '@ctx/store/provider-store.js';
import type { ChatProvider } from '@ctx/llm/chat-provider.js';
import { CopilotChatProvider } from '@ctx/llm/copilot/chat-provider.js';
import { priceFor, resolveModelId, humanizeBedrockError } from '@ctx/llm/bedrock/util.js';

// Re-export the Bedrock helpers (moved to the @ctx/llm leaf to avoid an
// llm<->indexer cycle) so existing importers of this module keep working.
export { priceFor, resolveModelId, humanizeBedrockError };

export interface AnalysisItem {
  path: string;
  language: string;
  content: string;
}

export interface AnalysisResult {
  summary: string;
  concepts: string[];
  layer: string; // validated against FileLayer; 'unknown' when the model is unsure
  inputTokens: number;
  outputTokens: number;
}

export interface ProjectSynthesis {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AnalysisProvider {
  readonly name: string;
  readonly model: string;
  analyze(item: AnalysisItem): Promise<AnalysisResult>;
  synthesize(
    projectName: string,
    files: Array<{ path: string; summary: string; layer: string }>,
  ): Promise<ProjectSynthesis>;
  /** Rough USD per million tokens — used for budget gating and cost logging. */
  price(): { inPerMTok: number; outPerMTok: number };
}

const LAYERS = new Set<FileLayer>([
  'presentation', 'business', 'data', 'infrastructure', 'config', 'test', 'unknown',
]);

export function normalizeLayer(s: unknown): string {
  return typeof s === 'string' && LAYERS.has(s.trim().toLowerCase() as FileLayer)
    ? s.trim().toLowerCase()
    : 'unknown';
}

/** Pull the first JSON object out of a model reply (tolerates fences / prose). */
function parseAnalysisJson(text: string): { summary: string; concepts: string[]; layer: string } {
  let summary = '';
  let concepts: string[] = [];
  let layer = 'unknown';
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { summary?: unknown; concepts?: unknown; layer?: unknown };
      if (typeof o.summary === 'string') summary = o.summary.trim();
      if (Array.isArray(o.concepts)) concepts = o.concepts.map((c) => String(c).trim()).filter(Boolean).slice(0, 5);
      layer = normalizeLayer(o.layer);
    } catch {
      /* fall through */
    }
  }
  if (!summary) summary = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  return { summary: summary.slice(0, 200), concepts, layer };
}

const ANALYZE_SYSTEM =
  'You are a code archaeologist. Read the file and reply with ONLY compact JSON ' +
  '(no markdown fences, no prose):\n' +
  '{"summary":"<one sentence, max 18 words, what the file does and its role>",' +
  '"concepts":["up to 5 short lowercase tags"],' +
  '"layer":"presentation|business|data|infrastructure|config|test|unknown"}';

const SYNTH_SYSTEM =
  'You are a software architect. Given a list of key files (path — summary [layer]), ' +
  'write a tight 3-5 sentence overview of the system architecture: its layers, the ' +
  'main flow, and notable hubs. Plain prose, no markdown headings.';

// ─── Bedrock (Converse) ─────────────────────────────────────────

interface ConverseClient {
  send: (cmd: unknown) => Promise<{
    output?: { message?: { content?: Array<{ text?: string }> } };
    usage?: { inputTokens?: number; outputTokens?: number };
  }>;
}
interface BedrockSdk {
  BedrockRuntimeClient: new (cfg: unknown) => ConverseClient;
  ConverseCommand: new (input: unknown) => unknown;
}

export class BedrockAnalysisService implements AnalysisProvider {
  readonly name = 'bedrock';
  readonly model: string;
  private region: string;
  private credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  private clientPromise: Promise<{ client: ConverseClient; sdk: BedrockSdk }> | null = null;

  constructor(opts: {
    model?: string;
    region?: string;
    inference?: boolean;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  }) {
    this.region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
    const raw = opts.model ?? 'amazon.titan-text-express-v1';
    this.model = resolveModelId(raw, this.region, opts.inference ?? false);
    if (opts.accessKeyId && opts.secretAccessKey) {
      this.credentials = {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        sessionToken: opts.sessionToken,
      };
    }
  }

  private async getClient(): Promise<{ client: ConverseClient; sdk: BedrockSdk }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        let sdk: BedrockSdk;
        try {
          const modName = '@aws-sdk/client-bedrock-runtime';
          sdk = (await import(/* @vite-ignore */ modName)) as unknown as BedrockSdk;
        } catch (e) {
          throw new Error(
            'Bedrock enrichment requires @aws-sdk/client-bedrock-runtime. Install with: ' +
              `pnpm add @aws-sdk/client-bedrock-runtime (${(e as Error).message})`,
          );
        }
        const client = new sdk.BedrockRuntimeClient({ region: this.region, credentials: this.credentials });
        return { client, sdk };
      })();
    }
    return this.clientPromise;
  }

  async analyze(item: AnalysisItem): Promise<AnalysisResult> {
    const { client, sdk } = await this.getClient();
    const user = `File: ${item.path} (${item.language})\n\n\`\`\`\n${item.content}\n\`\`\``;
    const cmd = new sdk.ConverseCommand({
      modelId: this.model,
      system: [{ text: ANALYZE_SYSTEM }],
      messages: [{ role: 'user', content: [{ text: user }] }],
      inferenceConfig: { maxTokens: 300, temperature: 0 },
    });
    let resp;
    try {
      resp = await client.send(cmd);
    } catch (e) {
      throw new Error(humanizeBedrockError(e, this.model));
    }
    const text = (resp.output?.message?.content ?? []).map((c) => c.text ?? '').join('');
    const parsed = parseAnalysisJson(text);
    return {
      summary: parsed.summary,
      concepts: parsed.concepts,
      layer: parsed.layer,
      inputTokens: resp.usage?.inputTokens ?? 0,
      outputTokens: resp.usage?.outputTokens ?? 0,
    };
  }

  async synthesize(
    projectName: string,
    files: Array<{ path: string; summary: string; layer: string }>,
  ): Promise<ProjectSynthesis> {
    const { client, sdk } = await this.getClient();
    const list = files.map((f) => `- ${f.path} — ${f.summary} [${f.layer}]`).join('\n');
    const cmd = new sdk.ConverseCommand({
      modelId: this.model,
      system: [{ text: SYNTH_SYSTEM }],
      messages: [{ role: 'user', content: [{ text: `Project: ${projectName}\n\nKey files:\n${list}` }] }],
      inferenceConfig: { maxTokens: 400, temperature: 0.2 },
    });
    let resp;
    try {
      resp = await client.send(cmd);
    } catch (e) {
      throw new Error(humanizeBedrockError(e, this.model));
    }
    const text = (resp.output?.message?.content ?? []).map((c) => c.text ?? '').join('').trim();
    return { text, inputTokens: resp.usage?.inputTokens ?? 0, outputTokens: resp.usage?.outputTokens ?? 0 };
  }

  price(): { inPerMTok: number; outPerMTok: number } {
    return priceFor(this.model);
  }
}

// ─── Chat-backed (any ChatProvider: Copilot, Bedrock, …) ────────

/**
 * Adapts any ChatProvider into an AnalysisProvider by prompting it with the
 * same analyze/synthesize system prompts the Bedrock path uses. This is how
 * enrich runs on the user's Copilot subscription (zero per-token cost).
 */
export class ChatBackedAnalysisService implements AnalysisProvider {
  readonly name: string;
  readonly model: string;

  constructor(private chat: ChatProvider) {
    this.name = chat.name;
    this.model = chat.model;
  }

  async analyze(item: AnalysisItem): Promise<AnalysisResult> {
    const user = `File: ${item.path} (${item.language})\n\n\`\`\`\n${item.content}\n\`\`\``;
    const r = await this.chat.chat(
      [
        { role: 'system', content: ANALYZE_SYSTEM },
        { role: 'user', content: user },
      ],
      { maxTokens: 300, temperature: 0 },
    );
    const parsed = parseAnalysisJson(r.text);
    return {
      summary: parsed.summary,
      concepts: parsed.concepts,
      layer: parsed.layer,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
    };
  }

  async synthesize(
    projectName: string,
    files: Array<{ path: string; summary: string; layer: string }>,
  ): Promise<ProjectSynthesis> {
    const list = files.map((f) => `- ${f.path} — ${f.summary} [${f.layer}]`).join('\n');
    const r = await this.chat.chat(
      [
        { role: 'system', content: SYNTH_SYSTEM },
        { role: 'user', content: `Project: ${projectName}\n\nKey files:\n${list}` },
      ],
      { maxTokens: 400, temperature: 0.2 },
    );
    return { text: r.text.trim(), inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens };
  }

  price(): { inPerMTok: number; outPerMTok: number } {
    return this.chat.price();
  }
}

// ─── Mock (offline preview / pipeline test) ─────────────────────

export class MockAnalysisService implements AnalysisProvider {
  readonly name = 'mock';
  readonly model = 'mock';

  async analyze(item: AnalysisItem): Promise<AnalysisResult> {
    const firstLine = (item.content.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 90);
    const base = item.path.replace(/\\/g, '/').split('/').pop() ?? item.path;
    return {
      summary: `[mock] ${item.language} ${base}: ${firstLine}`.slice(0, 160),
      concepts: item.path.replace(/\\/g, '/').split('/').filter(Boolean).slice(-3),
      layer: 'unknown',
      inputTokens: Math.ceil(item.content.length / 4),
      outputTokens: 24,
    };
  }

  async synthesize(
    projectName: string,
    files: Array<{ path: string; summary: string; layer: string }>,
  ): Promise<ProjectSynthesis> {
    const layers = [...new Set(files.map((f) => f.layer))].join(', ');
    return {
      text: `[mock] ${projectName}: ${files.length} key files spanning ${layers}.`,
      inputTokens: 40,
      outputTokens: 24,
    };
  }

  price(): { inPerMTok: number; outPerMTok: number } {
    return { inPerMTok: 0, outPerMTok: 0 };
  }
}

/** Build the configured provider, or null when enrichment is not enabled. */
export function createAnalysisService(opts: {
  kind?: string;
  model?: string;
  inference?: boolean;
  /** ProviderStore — required for the `copilot` backend (reads the OAuth token). */
  store?: ProviderStore;
}): AnalysisProvider | null {
  const kind = (opts.kind ?? process.env.CODE_CONTEXT_ANALYSIS ?? '').toLowerCase();
  if (kind === 'mock') return new MockAnalysisService();
  if (kind === 'bedrock') {
    return new BedrockAnalysisService({
      model: opts.model ?? process.env.CODE_CONTEXT_ANALYSIS_MODEL,
      inference: opts.inference ?? process.env.CODE_CONTEXT_ANALYSIS_INFERENCE === '1',
    });
  }
  if (kind === 'copilot') {
    if (!opts.store || !opts.store.getOAuth('copilot')) {
      process.stderr.write('[code-context] Copilot not connected — run: code-context login copilot\n');
      return null;
    }
    const model = opts.model ?? process.env.CODE_CONTEXT_ANALYSIS_MODEL ?? 'gpt-4o-mini';
    return new ChatBackedAnalysisService(new CopilotChatProvider(opts.store, { model }));
  }
  return null;
}
