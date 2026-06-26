/**
 * createChatProvider — resolve a ChatProvider by kind. Synchronous (constructors
 * don't do I/O); the actual token refresh / SDK import happens lazily on the
 * first chat() call.
 */
import type { ProviderStore } from '@ctx/store/provider-store.js';
import type { ChatProvider } from './chat-provider.js';
import { CopilotChatProvider } from './copilot/chat-provider.js';
import { BedrockChatProvider } from './bedrock/chat-provider.js';

export interface CreateChatProviderOpts {
  /** Provider kind: 'copilot' | 'bedrock'. Falls back to `providerId`. */
  kind?: string;
  providerId?: string;
  model?: string;
  inference?: boolean;
  region?: string;
}

export function createChatProvider(store: ProviderStore, opts: CreateChatProviderOpts): ChatProvider {
  const kind = (opts.kind ?? opts.providerId ?? '').toLowerCase();
  if (kind === 'copilot') return new CopilotChatProvider(store, { model: opts.model, providerId: 'copilot' });
  if (kind === 'bedrock') return new BedrockChatProvider({ model: opts.model, inference: opts.inference, region: opts.region });
  throw new Error(`unknown chat provider kind: ${kind || '(none)'} (expected 'copilot' or 'bedrock')`);
}
