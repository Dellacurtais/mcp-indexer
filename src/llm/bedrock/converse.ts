/**
 * Shared, tool-aware AWS Bedrock Converse call. One adapter for Titan, Nova,
 * Claude, Llama, … The @aws-sdk is a dynamic import (zero footprint unless a
 * Bedrock backend is actually used). Used by `BedrockChatProvider` and, through
 * it, the explorer sub-agent.
 *
 * Note: the enrich `BedrockAnalysisService` keeps its own inline Converse call
 * (non-tool, proven) — this module is the new shared primitive for *chat*.
 */
import type { ChatMessage, ToolSpec, ToolCall, ChatUsage } from '../chat-provider.js';
import { humanizeBedrockError } from './util.js';

export interface ConverseCreds {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

interface ConverseClient {
  send: (cmd: unknown) => Promise<{
    output?: { message?: { content?: Array<Record<string, unknown>> } };
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number };
    stopReason?: string;
  }>;
}
interface BedrockSdk {
  BedrockRuntimeClient: new (cfg: unknown) => ConverseClient;
  ConverseCommand: new (input: unknown) => unknown;
}

const clientCache = new Map<string, Promise<{ client: ConverseClient; sdk: BedrockSdk }>>();

async function getClient(creds: ConverseCreds): Promise<{ client: ConverseClient; sdk: BedrockSdk }> {
  const key = `${creds.region}|${creds.accessKeyId ?? ''}|${creds.sessionToken ?? ''}`;
  let p = clientCache.get(key);
  if (!p) {
    p = (async () => {
      let sdk: BedrockSdk;
      try {
        const modName = '@aws-sdk/client-bedrock-runtime';
        sdk = (await import(/* @vite-ignore */ modName)) as unknown as BedrockSdk;
      } catch (e) {
        throw new Error(
          'Bedrock requires @aws-sdk/client-bedrock-runtime. Install with: ' +
            `pnpm add @aws-sdk/client-bedrock-runtime (${(e as Error).message})`,
        );
      }
      const credentials =
        creds.accessKeyId && creds.secretAccessKey
          ? { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken }
          : undefined; // else fall back to the SDK default credential chain (env, profile, role)
      const client = new sdk.BedrockRuntimeClient({ region: creds.region, credentials });
      return { client, sdk };
    })();
    clientCache.set(key, p);
  }
  return p;
}

export interface ConverseRequest {
  modelId: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
  maxTokens?: number;
  temperature?: number;
}

export interface ConverseResponse {
  text: string;
  toolCalls?: ToolCall[];
  usage: ChatUsage;
  stopReason: string;
}

interface BedrockBlock {
  text?: string;
  toolUse?: { toolUseId: string; name: string; input?: Record<string, unknown> };
  toolResult?: { toolUseId: string; content: Array<{ text: string }> };
}
interface BedrockMsg {
  role: 'user' | 'assistant';
  content: BedrockBlock[];
}

/** Map one ChatMessage to a Bedrock role + content blocks (system handled separately). */
function mapOne(m: ChatMessage): BedrockMsg {
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [{ toolResult: { toolUseId: m.toolCallId ?? '', content: [{ text: m.content || '(no output)' }] } }],
    };
  }
  if (m.role === 'assistant') {
    const content: BedrockBlock[] = [];
    if (m.content && m.content.trim()) content.push({ text: m.content });
    for (const tc of m.toolCalls ?? []) {
      content.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: tc.arguments ?? {} } });
    }
    if (content.length === 0) content.push({ text: '(thinking)' }); // Bedrock rejects empty assistant turns
    return { role: 'assistant', content };
  }
  return { role: 'user', content: [{ text: m.content || '' }] };
}

/**
 * Build Bedrock messages, COALESCING consecutive same-role turns. This is
 * essential: after an assistant turn with N tool calls the loop appends N tool
 * replies (all role:'user' in Bedrock), and Converse requires strict
 * user/assistant alternation — so they must merge into one user turn.
 */
function toBedrockMessages(msgs: ChatMessage[]): BedrockMsg[] {
  const out: BedrockMsg[] = [];
  for (const m of msgs) {
    const mapped = mapOne(m);
    const last = out[out.length - 1];
    if (last && last.role === mapped.role) last.content.push(...mapped.content);
    else out.push({ role: mapped.role, content: [...mapped.content] });
  }
  return out;
}

function toBedrockTool(s: ToolSpec): unknown {
  const params =
    s.parameters && typeof s.parameters === 'object' ? (s.parameters as Record<string, unknown>) : {};
  const schema: Record<string, unknown> = { type: 'object', properties: {}, ...params };
  if (!schema.properties || typeof schema.properties !== 'object') schema.properties = {};
  return { toolSpec: { name: s.name, description: s.description, inputSchema: { json: schema } } };
}

/** Only emit a toolChoice for 'required' (broadest Bedrock model support). */
function mapToolChoice(choice: ConverseRequest['toolChoice']): unknown | undefined {
  return choice === 'required' ? { any: {} } : undefined;
}

export async function converse(creds: ConverseCreds, req: ConverseRequest): Promise<ConverseResponse> {
  const { client, sdk } = await getClient(creds);

  // Pull system text out of the messages (Converse wants it top-level).
  const systemParts = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
  const sys = [req.system, ...systemParts].filter((s): s is string => !!s && s.trim().length > 0).join('\n\n');
  const convo = req.messages.filter((m) => m.role !== 'system');

  const input: Record<string, unknown> = {
    modelId: req.modelId,
    messages: toBedrockMessages(convo),
    inferenceConfig: { maxTokens: req.maxTokens ?? 1024, temperature: req.temperature ?? 0 },
  };
  if (sys) input.system = [{ text: sys }];
  if (req.tools && req.tools.length) {
    const choice = mapToolChoice(req.toolChoice);
    input.toolConfig = { tools: req.tools.map(toBedrockTool), ...(choice ? { toolChoice: choice } : {}) };
  }

  let resp;
  try {
    resp = await client.send(new sdk.ConverseCommand(input));
  } catch (e) {
    throw new Error(humanizeBedrockError(e, req.modelId));
  }

  const blocks = (resp.output?.message?.content ?? []) as BedrockBlock[];
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const b of blocks) {
    if (typeof b.text === 'string') text += b.text;
    else if (b.toolUse) toolCalls.push({ id: b.toolUse.toolUseId, name: b.toolUse.name, arguments: b.toolUse.input ?? {} });
  }
  return {
    text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    usage: {
      inputTokens: resp.usage?.inputTokens ?? 0,
      outputTokens: resp.usage?.outputTokens ?? 0,
      cachedInputTokens: resp.usage?.cacheReadInputTokens ?? 0,
    },
    stopReason: resp.stopReason ?? 'end_turn',
  };
}
