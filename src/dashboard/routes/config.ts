/**
 * /api/config — read/write the managed keys of ~/.code-context/.env.
 * /api/models — dynamic model discovery via @aws-sdk/client-bedrock.
 * /api/config/test-aws — validate credentials by discovering models + a 1-token Converse.
 */
import { Hono } from 'hono';
import {
  readEnvFile,
  writeEnvFile,
  maskForBrowser,
  credsFromEnv,
} from '../env-file.js';
import {
  discoverModels,
  invalidateModelCache,
  type ModelOption,
  type AwsCreds,
} from '../models-discovery.js';
import { resolveModelId, humanizeBedrockError, priceFor } from '@ctx/indexer/analysis/analysis.js';

export const configApp = new Hono();

/** GET /api/config — the managed .env keys, secrets masked. */
configApp.get('/config', (c) => {
  const { path, values } = readEnvFile();
  return c.json({ path, values: maskForBrowser(values) });
});

/** POST /api/config — merge updates into the global .env (unknown keys preserved). */
configApp.post('/config', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, string | undefined>;
  const { path, values } = writeEnvFile(body);
  invalidateModelCache();
  return c.json({ path, values: maskForBrowser(values) });
});

/** GET /api/models — discover text models available in the user's account/region. */
configApp.get('/models', async (c) => {
  const { values } = readEnvFile();
  const creds = credsFromEnv(values);
  try {
    const models = await discoverModels(creds);
    return c.json({ models, region: creds.region });
  } catch (e) {
    return c.json(
      {
        error: e instanceof Error ? e.message : String(e),
        hint:
          'If @aws-sdk/client-bedrock is missing, install it with: pnpm add @aws-sdk/client-bedrock',
        models: [] as ModelOption[],
      },
      200, // 200 with an error payload so the UI can render the friendly message inline
    );
  }
});

/**
 * POST /api/config/test-aws — validate credentials by listing models and, when a
 * model is supplied, firing a 1-token Converse against it. Body may carry inline
 * creds (for "test before save"); otherwise the saved .env creds are used.
 */
configApp.post('/config/test-aws', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    model?: string; // optional resolved model id to Converse-test
    inference?: boolean;
  };
  const { values } = readEnvFile();
  const creds: AwsCreds = {
    region: body.region || values.AWS_REGION || process.env.AWS_REGION || 'us-east-1',
    accessKeyId: body.accessKeyId || values.AWS_ACCESS_KEY_ID,
    secretAccessKey: body.secretAccessKey && body.secretAccessKey !== '<set>' ? body.secretAccessKey : values.AWS_SECRET_ACCESS_KEY,
    sessionToken: body.sessionToken && body.sessionToken !== '<set>' ? body.sessionToken : values.AWS_SESSION_TOKEN,
  };

  // 1. Can we list models? (validates creds + bedrock:ListFoundationModels permission)
  let models: ModelOption[] = [];
  try {
    models = await discoverModels(creds);
  } catch (e) {
    return c.json({
      ok: false,
      stage: 'list-models',
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // 2. Optional: can we actually Converse with the chosen model?
  if (body.model) {
    const modelId = resolveModelId(body.model, creds.region, !!body.inference);
    try {
      const res = await converseProbe(creds, modelId);
      return c.json({
        ok: true,
        stage: 'converse',
        modelsFound: models.length,
        modelId,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
      });
    } catch (e) {
      return c.json({
        ok: false,
        stage: 'converse',
        modelsFound: models.length,
        modelId,
        error: humanizeBedrockError(e, modelId),
      });
    }
  }

  return c.json({ ok: true, stage: 'list-models', modelsFound: models.length });
});

/** Minimal Converse probe (1 token out) — reuses the runtime SDK if present. */
async function converseProbe(
  creds: AwsCreds,
  modelId: string,
): Promise<{ inputTokens: number; outputTokens: number }> {
  let sdk: { BedrockRuntimeClient: new (cfg: unknown) => unknown; ConverseCommand: new (i: unknown) => unknown };
  try {
    sdk = (await import('@aws-sdk/client-bedrock-runtime')) as unknown as typeof sdk;
  } catch (e) {
    throw new Error(
      '@aws-sdk/client-bedrock-runtime is not installed: pnpm add @aws-sdk/client-bedrock-runtime (' +
        (e as Error).message +
        ')',
    );
  }
  const client = new sdk.BedrockRuntimeClient({
    region: creds.region,
    ...(creds.accessKeyId && creds.secretAccessKey ? { credentials: creds } : {}),
  });
  const cmd = new sdk.ConverseCommand({
    modelId,
    messages: [{ role: 'user', content: [{ text: 'Reply with the single word: ok' }] }],
    inferenceConfig: { maxTokens: 1, temperature: 0 },
  });
  const resp = (await (client as { send: (c: unknown) => Promise<unknown> }).send(cmd)) as {
    usage?: { inputTokens?: number; outputTokens?: number };
  };
  return { inputTokens: resp.usage?.inputTokens ?? 0, outputTokens: resp.usage?.outputTokens ?? 0 };
}

void priceFor; // available if we later want per-model cost notes on the test result
