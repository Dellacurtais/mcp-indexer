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

export function priceFor(model: string): { inPerMTok: number; outPerMTok: number } {
  const m = model.toLowerCase();
  if (m.includes('titan-text-lite')) return { inPerMTok: 0.15, outPerMTok: 0.2 };
  if (m.includes('titan-text-express')) return { inPerMTok: 0.2, outPerMTok: 0.6 };
  if (m.includes('titan-text-premier')) return { inPerMTok: 0.5, outPerMTok: 1.5 };
  if (m.includes('nova-micro')) return { inPerMTok: 0.035, outPerMTok: 0.14 };
  if (m.includes('nova-lite')) return { inPerMTok: 0.06, outPerMTok: 0.24 };
  if (m.includes('nova-pro')) return { inPerMTok: 0.8, outPerMTok: 3.2 };
  if (m.includes('haiku')) return { inPerMTok: 0.8, outPerMTok: 4.0 };
  if (m.includes('sonnet')) return { inPerMTok: 3.0, outPerMTok: 15.0 };
  if (m.includes('llama')) return { inPerMTok: 0.2, outPerMTok: 0.2 };
  return { inPerMTok: 1.0, outPerMTok: 4.0 }; // conservative default → budget errs safe
}

/** Prepend the region inference-profile prefix unless the id already carries one. */
export function resolveModelId(model: string, region: string, inference: boolean): string {
  if (/^(us|eu|apac|us-gov)\./i.test(model)) return model;
  if (!inference) return model;
  const prefix = region.startsWith('eu') ? 'eu' : region.startsWith('ap') ? 'apac' : 'us';
  return `${prefix}.${model}`;
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

function humanizeBedrockError(e: unknown, model: string): string {
  if (!(e instanceof Error)) return String(e);
  const name = e.name;
  const msg = e.message;
  if (name === 'AccessDeniedException' || /access denied|not authorized/i.test(msg)) {
    return `Bedrock access denied for "${model}" — check AWS creds + model access at console.aws.amazon.com/bedrock (modelaccess). ${msg}`;
  }
  if (name === 'ValidationException' && /model identifier|inference profile/i.test(msg)) {
    return `Bedrock rejected model id "${model}" — not enabled in your region, or it needs an inference-profile id (try --inference, e.g. us.${model}). ${msg}`;
  }
  if (name === 'ThrottlingException') return `Bedrock throttled "${model}" — retry after a backoff. ${msg}`;
  if (name === 'ResourceNotFoundException') return `Bedrock model "${model}" not found in this region. ${msg}`;
  return `Bedrock error (${name || 'unknown'}): ${msg}`;
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
}): AnalysisProvider | null {
  const kind = (opts.kind ?? process.env.CODE_CONTEXT_ANALYSIS ?? '').toLowerCase();
  if (kind === 'mock') return new MockAnalysisService();
  if (kind === 'bedrock') {
    return new BedrockAnalysisService({
      model: opts.model ?? process.env.CODE_CONTEXT_ANALYSIS_MODEL,
      inference: opts.inference ?? process.env.CODE_CONTEXT_ANALYSIS_INFERENCE === '1',
    });
  }
  return null;
}
