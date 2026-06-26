/**
 * @ctx/llm — minimal chat-LLM layer. One ChatProvider seam, two backends
 * (GitHub Copilot via OAuth, AWS Bedrock via Converse). Consumed by enrich and
 * the explorer sub-agent.
 */
export type {
  ChatProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatUsage,
  ChatRole,
  ToolSpec,
  ToolCall,
  FinishReason,
} from './chat-provider.js';
export { createChatProvider, type CreateChatProviderOpts } from './factory.js';
export { CopilotChatProvider } from './copilot/chat-provider.js';
export { BedrockChatProvider } from './bedrock/chat-provider.js';
export { converse, type ConverseCreds, type ConverseRequest, type ConverseResponse } from './bedrock/converse.js';
export { priceFor, resolveModelId, humanizeBedrockError } from './bedrock/util.js';
