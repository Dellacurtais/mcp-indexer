/**
 * Pure Bedrock helpers shared by the enrich path (`indexer/analysis/analysis.ts`)
 * and the chat layer (`converse.ts` / `BedrockChatProvider`). Kept as a leaf
 * module (zero imports) so `@ctx/llm` never has to depend back on `@ctx/indexer`.
 */

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

export function humanizeBedrockError(e: unknown, model: string): string {
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
