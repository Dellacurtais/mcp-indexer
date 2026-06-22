/**
 * ProviderStore — persists the admin-configurable LLM providers, their API
 * keys, live/hardcoded model lists, OAuth tokens and embedding backends.
 *
 * Public API. Bodies live in sub-modules under `./provider/` so this file
 * stays under the 250-LOC ceiling. Schema is owned by migration 006.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

import * as providers from './provider/providers.js';
import * as models from './provider/models.js';
import * as modelPrices from './provider/model-prices.js';
import * as appSettings from './provider/app-settings.js';
import * as catalogEtag from './provider/catalog-etag.js';
import * as subagent from './provider/subagent.js';
import * as oauth from './provider/oauth.js';
import * as embedding from './provider/embedding.js';
import * as vectorStore from './provider/vector-store.js';
import * as reranker from './provider/reranker.js';
import * as globalTools from './provider/global-tools.js';
import { seedFromEnvIfEmpty } from './provider/seed.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

// Re-export public types so consumers of `@ctx/store/provider-store.js`
// keep working (`import type { ProviderConfig, ProviderModel, ... }`).
export type {
  ProviderKind,
  AuthMode,
  ProviderConfig,
  ProviderModel,
  OAuthTokenRow,
  EmbeddingKind,
  EmbeddingConfigRow,
  VectorStoreKind,
  VectorStoreConfigRow,
  RerankerKind,
  RerankerConfigRow,
  UpsertProviderInput,
  UpsertModelInput,
  ModelPriceRow,
  UpsertModelPriceInput,
} from './provider/types.js';

import type {
  ProviderConfig,
  ProviderModel,
  UpsertProviderInput,
  UpsertModelInput,
  OAuthTokenRow,
  EmbeddingConfigRow,
  VectorStoreConfigRow,
  RerankerConfigRow,
  ModelPriceRow,
  UpsertModelPriceInput,
} from './provider/types.js';

export class ProviderStore {
  private db: DB;
  private ownsConnection: boolean;

  constructor(dbPathOrInstance: string | DB) {
    if (typeof dbPathOrInstance === 'string') {
      this.db = new Database(dbPathOrInstance);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsConnection = true;
    } else {
      this.db = dbPathOrInstance;
      this.ownsConnection = false;
    }
  }

  close(): void { if (this.ownsConnection) this.db.close(); }

  // ─── Providers ─────────────────────────────────────────────────
  listProviders(filter?: providers.ListProvidersFilter): ProviderConfig[] { return providers.list(this.db, filter); }
  getDefaultProvider(): ProviderConfig | null { return providers.getDefault(this.db); }
  getDefaultProviderAndModel(): { kind: string; model: string | undefined } { return providers.getDefaultAndModel(this.db); }
  getProvider(id: string): ProviderConfig | null { return providers.get(this.db, id); }
  upsertProvider(input: UpsertProviderInput): ProviderConfig { return providers.upsert(this.db, input); }
  deleteProvider(id: string): void { providers.del(this.db, id); }

  // ─── Models ────────────────────────────────────────────────────
  listModels(providerId: string, onlyEnabled = false): ProviderModel[] { return models.list(this.db, providerId, onlyEnabled); }
  listAllModels(): ProviderModel[] { return models.listAll(this.db); }
  replaceModelsFromSource(providerId: string, source: string, modelInputs: UpsertModelInput[]): void { models.replaceFromSource(this.db, providerId, source, modelInputs); }
  updateModel(providerId: string, modelId: string, mode: string, patch: Parameters<typeof models.update>[4]): void { models.update(this.db, providerId, modelId, mode, patch); }
  deleteManualModel(providerId: string, modelId: string, mode: string): number { return models.remove(this.db, providerId, modelId, mode); }
  backfillContextWindowsFromRegistry(lookup: (modelId: string) => number | null): { updated: number; still_null: number; total: number } { return models.backfillContextWindows(this.db, lookup); }

  // ─── Model Prices ──────────────────────────────────────────────
  listAllModelPrices(): ModelPriceRow[] { return modelPrices.listAllPrices(this.db); }
  replaceModelPricesFromSource(source: string, prices: UpsertModelPriceInput[]): { inserted: number; skipped_protected: number } { return modelPrices.replacePricesFromSource(this.db, source, prices); }
  upsertManualModelPrice(input: UpsertModelPriceInput): void { modelPrices.upsertManualPrice(this.db, input); }
  seedHardcodedModelPrices(seed: UpsertModelPriceInput[]): number { return modelPrices.seedHardcodedPricesIfMissing(this.db, seed); }

  // ─── App Settings & General Default & Fallback ─────
  getAppSetting(key: string): string | null { return appSettings.getAppSetting(this.db, key); }
  setAppSetting(key: string, value: string): void { appSettings.setAppSetting(this.db, key, value); }
  getGeneralDefault(): { providerId: string; modelId: string } | null { return appSettings.getGeneralDefault(this.db); }
  setGeneralDefault(providerId: string, modelId: string): void { appSettings.setGeneralDefault(this.db, providerId, modelId); }
  getFallbackChain(providerId: string): Array<{ provider: string; model: string }> { return appSettings.getFallbackChain(this.db, providerId); }
  setFallbackProvider(providerId: string, fallbackProviderId: string | null): void { appSettings.setFallbackProvider(this.db, providerId, fallbackProviderId); }

  // ─── Catalog ETag ──────────────────────────────────────────────
  getProviderCatalogEtag(providerId: string): string | null { return catalogEtag.get(this.db, providerId); }
  setProviderCatalogEtag(providerId: string, etag: string | null): void { catalogEtag.set(this.db, providerId, etag); }

  // ─── Subagent ──────────────────────────────────────────────────
  getSubagentTarget(providerId: string): { providerId: string; modelId: string | null } | null { return subagent.getTarget(this.db, providerId); }
  getSubagentModel(providerId: string): string | null { return subagent.getModel(this.db, providerId); }
  setSubagentModel(providerId: string, modelId: string | null): void { subagent.setModel(this.db, providerId, modelId); }
  setSubagentTarget(providerId: string, targetProviderId: string | null, modelId: string | null): void { subagent.setTarget(this.db, providerId, targetProviderId, modelId); }

  // ─── OAuth ─────────────────────────────────────────────────────
  getOAuth(providerId: string): OAuthTokenRow | null { return oauth.get(this.db, providerId); }
  setOAuth(input: oauth.SetOAuthInput): void { oauth.set(this.db, input); }
  deleteOAuth(providerId: string): void { oauth.del(this.db, providerId); }

  // ─── Embeddings ────────────────────────────────────────────────
  listEmbeddingConfigs(): EmbeddingConfigRow[] { return embedding.list(this.db); }
  getDefaultEmbedding(): EmbeddingConfigRow | null { return embedding.getDefault(this.db); }
  upsertEmbeddingConfig(input: embedding.UpsertEmbeddingInput): EmbeddingConfigRow { return embedding.upsert(this.db, input); }

  // ─── Vector Stores ─────────────────────────────────────────────
  listVectorStoreConfigs(): VectorStoreConfigRow[] { return vectorStore.list(this.db); }
  getDefaultVectorStore(): VectorStoreConfigRow | null { return vectorStore.getDefault(this.db); }
  upsertVectorStoreConfig(input: vectorStore.UpsertVectorStoreInput): VectorStoreConfigRow { return vectorStore.upsert(this.db, input); }

  // ─── Rerankers ─────────────────────────────────────────────────
  listRerankerConfigs(): RerankerConfigRow[] { return reranker.list(this.db); }
  getDefaultReranker(): RerankerConfigRow | null { return reranker.getDefault(this.db); }
  upsertRerankerConfig(input: reranker.UpsertRerankerInput): RerankerConfigRow { return reranker.upsert(this.db, input); }

  // ─── Global Disabled Tools ─────────────────────────────────────
  listGlobalDisabledTools(): string[] { return globalTools.listDisabled(this.db); }
  setGlobalToolDisabled(toolName: string, disabled: boolean, meta?: { tier: string; source: string }): void { globalTools.setDisabled(this.db, toolName, disabled, meta); }
  bulkSetGlobalDisabled(tools: Array<{ tool_name: string; disabled: boolean; tier?: string; source?: string }>): void { globalTools.bulkSetDisabled(this.db, tools); }

  // ─── Bootstrap ─────────────────────────────────────────────────
  seedFromEnvIfEmpty(): void { seedFromEnvIfEmpty(this.db); }
}
