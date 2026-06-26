/**
 * BedrockChatProvider — a ChatProvider over AWS Bedrock Converse. Creds come
 * from the explicit options or (when absent) the SDK default credential chain
 * (AWS_* env, shared profile, instance role), mirroring BedrockAnalysisService.
 */
import type { ChatProvider, ChatMessage, ChatOptions, ChatResult, FinishReason } from '../chat-provider.js';
import { converse, type ConverseCreds } from './converse.js';
import { priceFor, resolveModelId } from './util.js';

export interface BedrockChatOptions {
  model?: string;
  region?: string;
  inference?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export class BedrockChatProvider implements ChatProvider {
  readonly name = 'bedrock';
  readonly model: string;
  private creds: ConverseCreds;

  constructor(opts: BedrockChatOptions) {
    const region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
    // Default to a cheap, tool-capable model — the explorer's whole point.
    this.model = resolveModelId(opts.model ?? 'amazon.nova-lite-v1:0', region, opts.inference ?? false);
    this.creds = { region };
    if (opts.accessKeyId && opts.secretAccessKey) {
      this.creds.accessKeyId = opts.accessKeyId;
      this.creds.secretAccessKey = opts.secretAccessKey;
      this.creds.sessionToken = opts.sessionToken;
    }
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const r = await converse(this.creds, {
      modelId: this.model,
      messages,
      tools: opts?.tools,
      toolChoice: opts?.toolChoice,
      maxTokens: opts?.maxTokens,
      temperature: opts?.temperature,
    });
    const finishReason: FinishReason =
      r.stopReason === 'tool_use' ? 'tool_calls' : r.stopReason === 'max_tokens' ? 'length' : 'stop';
    return { text: r.text, toolCalls: r.toolCalls, usage: r.usage, finishReason };
  }

  price(): { inPerMTok: number; outPerMTok: number } {
    return priceFor(this.model);
  }
}
