/**
 * ChatProvider — the single seam the chat layer exposes. enrich, the explorer
 * sub-agent and any future LLM feature code against THIS interface; concrete
 * backends (Copilot via OAuth, AWS Bedrock) implement it. Supports tool /
 * function calling, which the explorer relies on.
 *
 * Wire mapping (kept here as the contract; each backend translates):
 *  - OpenAI-compat (Copilot): tools -> [{type:'function',function:{name,description,parameters}}];
 *    assistant tool requests come back on choices[0].message.tool_calls with a
 *    JSON-string `arguments`; a tool reply is {role:'tool', tool_call_id, content}.
 *  - Bedrock Converse: tools -> toolConfig.tools[].toolSpec.inputSchema.json;
 *    `system` is a top-level param (not a message); a tool request is a
 *    {toolUse} content block and a tool reply is a user msg with {toolResult}.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** A tool/function the model may call. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A tool call the model requested. `arguments` is already parsed to an object. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant turn requesting tools */
  toolCalls?: ToolCall[];
  /** role:'tool' — which call this answers */
  toolCallId?: string;
  /** role:'tool' — the tool name (Bedrock needs it; harmless for OpenAI) */
  name?: string;
}

export interface ChatOptions {
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
  maxTokens?: number;
  temperature?: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other';

export interface ChatResult {
  text: string;
  toolCalls?: ToolCall[];
  usage: ChatUsage;
  finishReason: FinishReason;
}

export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  /** Rough USD per million tokens — for budget gating + cost logging. */
  price(): { inPerMTok: number; outPerMTok: number };
}
