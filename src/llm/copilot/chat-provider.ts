/**
 * CopilotChatProvider — a ChatProvider over GitHub Copilot.
 *
 * Copilot serves models over TWO wires: the classic OpenAI `/chat/completions`
 * and the newer `/responses` API (GPT-5.x and other newer models are
 * responses-only and reject /chat/completions with `unsupported_api_for_model`).
 * We try /chat/completions first and transparently fall back to /responses on
 * that error, caching the decision per model so a loop pays the probe once.
 *
 * Token is refreshed on use from the stored PAT. price() is zero — usage is
 * governed by the user's Copilot subscription.
 */
import type { ProviderStore } from '@ctx/store/provider-store.js';
import type {
  ChatProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ToolSpec,
  ToolCall,
  ChatUsage,
  FinishReason,
} from '../chat-provider.js';
import { refreshIfExpired, copilotHeaders, getStoredCopilotEndpoints } from './oauth.js';

const DEFAULT_BASE = 'https://api.githubcopilot.com';

/** Models discovered (this process) to be responses-only — skip the chat probe. */
const responsesOnly = new Set<string>();

function safeJsonParse(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const o = JSON.parse(s) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isUnsupportedApi(msg: string): boolean {
  return /unsupported_api_for_model|not accessible via the \/chat\/completions|use the \/responses/i.test(msg);
}

function mapFinish(reason: string | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return 'tool_calls';
  if (reason === 'length' || reason === 'max_output_tokens' || reason === 'incomplete') return 'length';
  if (reason === 'stop' || reason === 'completed') return 'stop';
  return 'other';
}

// ─── /chat/completions wire ─────────────────────────────────────────

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAIToolCall[] }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

function toChatMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      return {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

const toChatTool = (s: ToolSpec): unknown => ({
  type: 'function',
  function: { name: s.name, description: s.description, parameters: s.parameters },
});

// ─── /responses wire ────────────────────────────────────────────────

interface ResponsesOutputItem {
  type?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: string;
  status?: string;
}
interface ResponsesResponse {
  output?: ResponsesOutputItem[];
  output_text?: string;
  status?: string;
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
}

/** Map our messages into Responses `input` items (function calls/outputs are flat items). */
function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      if (m.content && m.content.trim()) input.push({ role: 'assistant', content: m.content });
      for (const tc of m.toolCalls) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) });
      }
      continue;
    }
    input.push({ role: m.role, content: m.content });
  }
  return input;
}

const toResponsesTool = (s: ToolSpec): unknown => ({
  type: 'function',
  name: s.name,
  description: s.description,
  parameters: s.parameters,
});

export class CopilotChatProvider implements ChatProvider {
  readonly name = 'copilot';
  readonly model: string;
  private providerId: string;

  constructor(private store: ProviderStore, opts: { model?: string; providerId?: string } = {}) {
    this.model = opts.model ?? 'gpt-4o-mini';
    this.providerId = opts.providerId ?? 'copilot';
  }

  private async creds(): Promise<{ token: string; baseURL: string }> {
    const token = await refreshIfExpired(this.store, this.providerId);
    if (!token) throw new Error('Copilot not connected — run: code-context login copilot');
    const baseURL = getStoredCopilotEndpoints(this.store, this.providerId) ?? DEFAULT_BASE;
    return { token, baseURL };
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const { token, baseURL } = await this.creds();
    if (responsesOnly.has(this.model)) return this.viaResponses(token, baseURL, messages, opts);
    try {
      return await this.viaChatCompletions(token, baseURL, messages, opts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isUnsupportedApi(msg)) {
        responsesOnly.add(this.model); // this model needs /responses — remember it
        return this.viaResponses(token, baseURL, messages, opts);
      }
      throw e;
    }
  }

  private async viaChatCompletions(
    token: string,
    baseURL: string,
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResult> {
    const body: Record<string, unknown> = { model: this.model, messages: toChatMessages(messages) };
    if (opts?.maxTokens != null) body.max_tokens = opts.maxTokens;
    if (opts?.temperature != null) body.temperature = opts.temperature;
    if (opts?.tools && opts.tools.length) {
      body.tools = opts.tools.map(toChatTool);
      if (opts.toolChoice && opts.toolChoice !== 'auto') body.tool_choice = opts.toolChoice === 'required' ? 'required' : 'none';
    }
    const r = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { ...copilotHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Copilot chat failed: HTTP ${r.status} ${await r.text()}`);
    const data = (await r.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    const msg = choice?.message ?? {};
    const text = typeof msg.content === 'string' ? msg.content : '';
    const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
      .filter((tc) => tc.function?.name)
      .map((tc) => ({ id: tc.id ?? '', name: tc.function!.name as string, arguments: safeJsonParse(tc.function?.arguments) }));
    const usage: ChatUsage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined, usage, finishReason: mapFinish(choice?.finish_reason, toolCalls.length > 0) };
  }

  private async viaResponses(
    token: string,
    baseURL: string,
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResult> {
    const body: Record<string, unknown> = { model: this.model, input: toResponsesInput(messages) };
    if (opts?.maxTokens != null) body.max_output_tokens = opts.maxTokens;
    // temperature is intentionally omitted: many responses-only models are
    // reasoning models that reject a non-default temperature.
    if (opts?.tools && opts.tools.length) {
      body.tools = opts.tools.map(toResponsesTool);
      body.tool_choice = opts.toolChoice && opts.toolChoice !== 'auto' ? opts.toolChoice : 'auto';
    }
    const r = await fetch(`${baseURL}/responses`, {
      method: 'POST',
      headers: { ...copilotHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Copilot responses failed: HTTP ${r.status} ${await r.text()}`);
    const data = (await r.json()) as ResponsesResponse;
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const item of data.output ?? []) {
      if (item.type === 'function_call' && item.name) {
        toolCalls.push({ id: item.call_id ?? item.id ?? '', name: item.name, arguments: safeJsonParse(item.arguments) });
      } else if (item.type === 'message' || item.role === 'assistant') {
        // Collect ANY text content part (not only type==='output_text') — reasoning
        // models vary the part type, and missing this is how a wrap-up came back blank.
        for (const p of item.content ?? []) if (typeof p.text === 'string') text += p.text;
      }
    }
    if (!text && typeof data.output_text === 'string') text = data.output_text;
    const usage: ChatUsage = {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      cachedInputTokens: data.usage?.input_tokens_details?.cached_tokens ?? 0,
    };
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined, usage, finishReason: mapFinish(data.status, toolCalls.length > 0) };
  }

  price(): { inPerMTok: number; outPerMTok: number } {
    return { inPerMTok: 0, outPerMTok: 0 };
  }
}
