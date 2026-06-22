/**
 * HyDE — Hypothetical Document Embeddings.
 *
 * Given a natural-language query, ask an LLM to draft a short, hypothetical
 * *answer snippet* (docstring-style) that would plausibly live in the
 * codebase. Embed that synthetic document and use the resulting vector for
 * ANN search. On code corpora with NL questions, this recovers tokens the
 * raw query would never match ("how does the retry loop handle 429s?" →
 * hypothetical: `// Exponential backoff retry handler for HTTP 429 responses`).
 *
 * We deliberately do NOT touch the LLMProvider interface: HyDE only needs a
 * one-shot chat completion, and adding a generic `complete()` to every
 * provider would ripple across 6 files. Instead this service spins up its
 * own minimal client from the ProviderStore default row.
 *
 * Supports two shapes:
 *   - Anthropic (claude-haiku-4-5) via @anthropic-ai/sdk
 *   - OpenAI-compatible (openai, openrouter, zai, deepseek, ...) via openai SDK
 *
 * Results are cached in-process keyed by query — consecutive calls for the
 * same question are free.
 */
import type { ProviderStore, ProviderConfig } from '@ctx/store/provider-store.js';

export class HyDEService {
  private store: ProviderStore | null;
  private cache = new Map<string, string>();
  private cacheMax = 128;

  constructor(store: ProviderStore | null) {
    this.store = store;
  }

  /**
   * Return the cached hypothetical document for this query if present,
   * otherwise generate one, cache, and return. On any error the query is
   * returned unchanged — the caller should treat "HyDE output === input"
   * as a graceful fallback.
   */
  async generate(query: string, projectContext?: { language?: string; concepts?: string[] }): Promise<string> {
    const key = query.trim();
    if (!key) return query;

    const cached = this.cache.get(key);
    if (cached) return cached;

    if (!this.store) return query;
    const cfg = this.pickProvider();
    if (!cfg) return query;

    try {
      const text = await this.callLLM(cfg, key, projectContext);
      const cleaned = this.clean(text);
      if (!cleaned || cleaned.length < 8) return query;
      // LRU-ish eviction: drop oldest when full.
      if (this.cache.size >= this.cacheMax) {
        const first = this.cache.keys().next().value;
        if (first !== undefined) this.cache.delete(first);
      }
      this.cache.set(key, cleaned);
      return cleaned;
    } catch (err) {
      console.error('[hyde] generation failed:', (err as Error).message);
      return query;
    }
  }

  /**
   * Pick the default-enabled provider suitable for one-shot chat. We avoid
   * the OAuth kinds (copilot/chatgpt) because they need async token refresh
   * that isn't worth threading through for a ~50-token call — the fallback
   * to raw query is acceptable when the default is copilot.
   */
  private pickProvider(): ProviderConfig | null {
    if (!this.store) return null;
    const rows = this.store.listProviders({ enabled: true });
    const usable = rows.filter(
      (r) => r.api_key && r.kind !== 'copilot' && r.kind !== 'chatgpt' && r.kind !== 'bedrock'
    );
    if (usable.length === 0) return null;
    return usable.find((r) => r.is_default) ?? usable[0];
  }

  private async callLLM(cfg: ProviderConfig, query: string, projectContext?: { language?: string; concepts?: string[] }): Promise<string> {
    const prompt = buildHyDEPrompt(query, projectContext);
    if (cfg.kind === 'anthropic') return this.callAnthropic(cfg, prompt);
    // OpenAI-compatible: openai, openrouter, zai, deepseek, and any "kind: openai" custom.
    return this.callOpenAICompat(cfg, prompt);
  }

  // LLM-based HyDE is disabled in code-context — the server is retrieval-only
  // and seeds no chat/LLM provider. Hybrid search still runs; it simply skips
  // the synthetic HyDE document expansion (these return empty). The original
  // @anthropic-ai/sdk / openai dynamic imports were removed to keep the
  // dependency surface LLM-free.
  private async callAnthropic(_cfg: ProviderConfig, _prompt: string): Promise<string> {
    return '';
  }

  private async callOpenAICompat(_cfg: ProviderConfig, _prompt: string): Promise<string> {
    return '';
  }

  private defaultModelFor(kind: string): string {
    switch (kind) {
      case 'openai':
        return 'gpt-4o-mini';
      case 'openrouter':
        return 'openai/gpt-4o-mini';
      case 'deepseek':
        return 'deepseek-chat';
      case 'zai':
        return 'glm-4.5-flash';
      case 'gemini':
        return 'gemini-2.0-flash-lite';
      default:
        return 'gpt-4o-mini';
    }
  }

  /**
   * Strip fences / boilerplate and cap length. The LLM occasionally
   * over-answers with explanatory prose; we only want the hypothetical
   * snippet that gets embedded.
   */
  private clean(text: string): string {
    let t = text.trim();
    // Remove triple-fenced blocks but keep their contents.
    const fenced = t.match(/```(?:[a-zA-Z]+)?\n?([\s\S]*?)```/);
    if (fenced) t = fenced[1].trim();
    // Collapse excessive whitespace.
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    // Cap to ~500 chars — embeddings are insensitive to length beyond that.
    return t.slice(0, 500);
  }
}

/**
 * Build the one-shot prompt. Short, concrete, and primed toward
 * code-shaped output (comments + signatures) rather than natural language
 * essays — the goal is to land in the same embedding neighborhood as the
 * actual source code.
 */
function buildHyDEPrompt(query: string, ctx?: { language?: string; concepts?: string[] }): string {
  const contextHint = ctx
    ? `\nProject context: ${ctx.language ? `primary language: ${ctx.language}` : ''}${ctx.concepts?.length ? `, key concepts: ${ctx.concepts.slice(0, 8).join(', ')}` : ''}\n`
    : '';

  return `Write a short hypothetical code snippet or docstring (3-6 lines) that would answer this question. Do not explain. Output only code-like content with key function/class names and types. No markdown fences.
${contextHint}
Question: ${query}

Hypothetical snippet:`;
}
