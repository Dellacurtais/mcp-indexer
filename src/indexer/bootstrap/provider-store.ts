import { ProviderStore } from '@ctx/store/provider-store.js';

/**
 * Single entry point for building a ProviderStore with legacy .env
 * migration applied. Centralized here so apps (http-api, mcp-server,
 * cli) don't each repeat `new ProviderStore(dbPath); seedFromEnvIfEmpty()`.
 */
export function createAndSeedProviderStore(dbPath: string): ProviderStore {
  const store = new ProviderStore(dbPath);
  store.seedFromEnvIfEmpty();
  return store;
}
