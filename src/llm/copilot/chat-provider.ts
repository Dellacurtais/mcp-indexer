/**
 * CopilotChatProvider — a ChatProvider over the GitHub Copilot OpenAI-compatible
 * /chat/completions endpoint. Token is refreshed on use from the stored PAT.
 * price() is zero: usage is governed by the user's Copilot subscription.
 */
import type { ProviderStore } from '@ctx/store/provider-store.js';
import type {
  ChatProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ToolSpec,
  ToolCall,
  FinishReason,
} from '../chat-provider.js';
import { refreshIfExpired, copilotHeaders, getStoredCopilotEndpoints } from './oauth.js';

const DEFAULT_BASE = 'https://api.githubcopilot.com';

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface OpenAIChoice {
  message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
  finish_reason?: string;
}
interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function safeJsonParse(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const o = JSON.parse(s) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
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

function toOpenAITool(s: ToolSpec): unknown {
  return { type: 'function', function: { name: s.name, description: s.description, parameters: s.parameters } };
}

function mapFinish(reason: string | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls || reason === 'tool_calls') return 'tool_calls';
  if (reason === 'length') return 'length';
  if (reason === 'stop') return 'stop';
  return 'other';
}

export class CopilotChatProvider implements ChatProvider {
  readonly name = 'copilot';
  readonly model: string;
  private providerId: string;

  constructor(private store: ProviderStore, opts: { model?: string; providerId?: string } = {}) {
    this.model = opts.model ?? 'gpt-4o-mini';
    this.providerId = opts.providerId ?? 'copilot';
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const token = await refreshIfExpired(this.store, this.providerId);
    if (!token) throw new Error('Copilot not connected — run: code-context login copilot');
    const baseURL = getStoredCopilotEndpoints(this.store, this.providerId) ?? DEFAULT_BASE;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(messages),
    };
    if (opts?.maxTokens != null) body.max_tokens = opts.maxTokens;
    if (opts?.temperature != null) body.temperature = opts.temperature;
    if (opts?.tools && opts.tools.length) {
      body.tools = opts.tools.map(toOpenAITool);
      if (opts.toolChoice && opts.toolChoice !== 'auto') {
        body.tool_choice = opts.toolChoice === 'required' ? 'required' : 'none';
      }
    }

    const r = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { ...copilotHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      // Do not surface the auth headers; only status + server message.
      throw new Error(`Copilot chat failed: HTTP ${r.status} ${await r.text()}`);
    }
    const data = (await r.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    const msg = choice?.message ?? {};
    const text = typeof msg.content === 'string' ? msg.content : '';
    const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
      .filter((tc) => tc.function?.name)
      .map((tc) => ({ id: tc.id ?? '', name: tc.function!.name as string, arguments: safeJsonParse(tc.function?.arguments) }));
    return {
      text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
      finishReason: mapFinish(choice?.finish_reason, toolCalls.length > 0),
    };
  }

  price(): { inPerMTok: number; outPerMTok: number } {
    return { inPerMTok: 0, outPerMTok: 0 };
  }
}
