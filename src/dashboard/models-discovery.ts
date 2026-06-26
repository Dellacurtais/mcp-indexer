/**
 * Dynamic model discovery via the AWS Bedrock CONTROL-PLANE client
 * (`@aws-sdk/client-bedrock`) — NOT the runtime client already used by enrich.
 *
 * Replaces the rejected static catalog: this lists the models the user's account
 * can actually access in their region, and resolves cross-region inference
 * profiles automatically — killing the `us./eu./apac.` prefix confusion.
 *
 * `@aws-sdk/client-bedrock` is an optional dependency; the dynamic import mirrors
 * the pattern in src/indexer/analysis/analysis.ts:155 so a missing dep degrades
 * to a friendly error instead of crashing the server.
 */
import { priceFor, resolveModelId, humanizeBedrockError } from '@ctx/indexer/analysis/analysis.js';

export interface AwsCreds {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export interface ModelOption {
  /** Raw foundation model id (what the user thinks they picked). */
  id: string;
  /** Human label — `modelName` from Bedrock, or a cleaned-up id fallback. */
  label: string;
  /** `providerName` (Amazon, Anthropic, Meta, Mistral, …). */
  provider: string;
  /** Whether a regional inference profile is needed for this model. */
  needsInference: boolean;
  /** The id to actually pass to Converse (prefix resolved from region). */
  resolvedId: string;
  /** Does it support response streaming (informational). */
  supportsStream: boolean;
  /** Rough USD per million tokens, derived from priceFor() for cost preview. */
  price: { inPerMTok: number; outPerMTok: number };
}

interface BedrockControlSdk {
  BedrockClient: new (cfg: unknown) => { send: (cmd: unknown) => Promise<unknown> };
  ListFoundationModelsCommand: new (input: unknown) => unknown;
  ListInferenceProfilesCommand: new (input: unknown) => unknown;
}

let sdkPromise: Promise<BedrockControlSdk> | null = null;
async function loadSdk(): Promise<BedrockControlSdk> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      try {
        return (await import('@aws-sdk/client-bedrock')) as unknown as BedrockControlSdk;
      } catch (e) {
        throw new Error(
          'Model discovery requires @aws-sdk/client-bedrock. Install with: ' +
            `pnpm add @aws-sdk/client-bedrock (${(e as Error).message})`,
        );
      }
    })();
  }
  return sdkPromise;
}

interface FoundationModelSummary {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  responseStreamingSupported?: boolean;
  modelLifecycle?: { status?: string };
}

interface InferenceProfileSummary {
  inferenceProfileId?: string;
  inferenceProfileName?: string;
  type?: string;
  status?: string;
  models?: Array<{ modelName?: string; modelArn?: string }>;
}

/** Friendly label: prefer modelName, else humanize the id. */
function labelFor(m: FoundationModelSummary): string {
  if (m.modelName) return m.modelName;
  if (!m.modelId) return 'Unknown model';
  // "amazon.nova-lite-v1:0" -> "Amazon Nova Lite V1:0"
  return m.modelId
    .replace(/^[a-z]+\./, '') // drop a leading region prefix if present
    .split(/[.]/)
    .map((p) =>
      p
        .split('-')
        .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' '),
    )
    .join(' ');
}

/**
 * List discoverable text models, enriched with the regional inference profile
 * when one exists. Cached for `ttlMs` to avoid hammering the API on every render.
 */
export async function discoverModels(creds: AwsCreds, ttlMs = 5 * 60 * 1000): Promise<ModelOption[]> {
  const cached = cacheGet(creds);
  if (cached) return cached;

  const sdk = await loadSdk();
  const client = new sdk.BedrockClient({
    region: creds.region,
    ...(creds.accessKeyId && creds.secretAccessKey
      ? { credentials: creds }
      : {}),
  });

  let models: FoundationModelSummary[];
  let profiles: InferenceProfileSummary[];
  try {
    const fmRaw = (await client.send(
      new sdk.ListFoundationModelsCommand({
        byOutputModality: 'TEXT',
      } as Record<string, unknown>),
    )) as { modelSummaries?: FoundationModelSummary[] };
    models = fmRaw.modelSummaries ?? [];

    const ipRaw = (await client.send(
      new sdk.ListInferenceProfilesCommand({ type: 'SYSTEM_DEFINED' } as Record<string, unknown>),
    )) as { inferenceProfileSummaries?: InferenceProfileSummary[] };
    profiles = ipRaw.inferenceProfileSummaries ?? [];
  } catch (e) {
    throw new Error(humanizeBedrockError(e, '<model-list>'));
  }

  // Index inference profiles by the base model name they wrap, for the active region.
  const profileByModel = new Map<string, InferenceProfileSummary>();
  for (const p of profiles) {
    if (p.status && p.status !== 'ACTIVE') continue;
    for (const pm of p.models ?? []) {
      if (pm.modelName) profileByModel.set(pm.modelName, p);
    }
  }

  const out: ModelOption[] = [];
  for (const m of models) {
    // Only keep text-in / text-out (or text-capable) models; drop image/embed-only.
    const inMods = m.inputModalities ?? [];
    const outMods = m.outputModalities ?? [];
    if (!outMods.includes('TEXT')) continue;
    if (m.modelLifecycle?.status && m.modelLifecycle.status !== 'ACTIVE') continue; // skip LEGACY
    void inMods;

    const baseId = m.modelId ?? '';
    if (!baseId) continue;
    const profile = profileByModel.get(m.modelName ?? '');
    const needsInference = !!profile;
    // When a profile exists, the correct Converse id is the profile id
    // (e.g. "us.amazon.nova-lite-v1:0"); otherwise resolveModelId handles the
    // prefix convention for inference-profile-only models without a system profile.
    const resolvedId = profile?.inferenceProfileId ?? resolveModelId(baseId, creds.region, !!profile);
    const price = priceFor(baseId);

    out.push({
      id: baseId,
      label: labelFor(m),
      provider: m.providerName ?? 'Unknown',
      needsInference,
      resolvedId,
      supportsStream: !!m.responseStreamingSupported,
      price,
    });
  }

  // Stable, useful order: cheaper input first within each provider; Anthropic last (premium).
  out.sort((a, b) => {
    if (a.provider !== b.provider) {
      const rank = (p: string) =>
        /amazon/i.test(p) ? 0 : /meta|mistral|cohere/i.test(p) ? 1 : /anthropic/i.test(p) ? 3 : 2;
      return rank(a.provider) - rank(b.provider);
    }
    return a.price.inPerMTok - b.price.inPerMTok;
  });

  cacheSet(creds, out, ttlMs);
  return out;
}

// ─── tiny TTL cache keyed by region+access key ────────────────────────────────
interface CacheEntry {
  expires: number;
  models: ModelOption[];
}
const cache = new Map<string, CacheEntry>();
function cacheKey(creds: AwsCreds): string {
  return `${creds.region}:${creds.accessKeyId ?? 'env'}`;
}
function cacheGet(creds: AwsCreds): ModelOption[] | null {
  const e = cache.get(cacheKey(creds));
  if (!e) return null;
  if (Date.now() > e.expires) {
    cache.delete(cacheKey(creds));
    return null;
  }
  return e.models;
}
function cacheSet(creds: AwsCreds, models: ModelOption[], ttlMs: number): void {
  cache.set(cacheKey(creds), { expires: Date.now() + ttlMs, models });
}

/** Drop the cache (e.g. after the user saves new credentials). */
export function invalidateModelCache(): void {
  cache.clear();
}
