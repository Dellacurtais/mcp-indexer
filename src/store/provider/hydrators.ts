import type {
  AuthMode,
  EmbeddingConfigRow,
  EmbeddingKind,
  OAuthTokenRow,
  ProviderConfig,
  ProviderKind,
  ProviderModel,
  RerankerConfigRow,
  RerankerKind,
  VectorStoreConfigRow,
  VectorStoreKind,
} from './types.js';

export interface ProviderConfigRaw {
  id: string;
  name: string;
  kind: string;
  base_url: string | null;
  api_key: string | null;
  auth_mode: string;
  enabled: number;
  use_for_agent: number;
  use_for_coder: number;
  use_for_general: number;
  is_default: number;
  extra: string | null;
  fallback_provider_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderModelRaw {
  provider_id: string;
  model_id: string;
  mode: string;
  name: string;
  context_window: number | null;
  default_max_tokens: number | null;
  can_reason: number;
  supports_attachments: number;
  enabled: number;
  source: string;
  updated_at: string;
  display_name: string | null;
  description: string | null;
  default_reasoning_level: string | null;
  supported_reasoning_levels: string | null;
  apply_patch_tool_type: string | null;
  available_in_plans: string | null;
  minimal_client_version: string | null;
  visibility: string | null;
  supported_in_api: number | null;
  input_modalities: string | null;
  max_tools: number | null;
}

export interface OAuthTokenRaw {
  provider_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  scope: string | null;
  extra: string | null;
  updated_at: string;
}

export interface EmbeddingConfigRaw {
  id: string;
  kind: string;
  name: string;
  enabled: number;
  is_default: number;
  config: string;
  updated_at: string;
}

export interface VectorStoreConfigRaw {
  id: string;
  kind: string;
  name: string;
  enabled: number;
  is_default: number;
  config: string;
  updated_at: string;
}

export interface RerankerConfigRaw {
  id: string;
  kind: string;
  name: string;
  enabled: number;
  is_default: number;
  config: string;
  updated_at: string;
}

export function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; }
  catch { return fallback; }
}

export function hydrateProvider(r: ProviderConfigRaw): ProviderConfig {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as ProviderKind,
    base_url: r.base_url,
    api_key: r.api_key,
    auth_mode: r.auth_mode as AuthMode,
    enabled: !!r.enabled,
    use_for_agent: !!r.use_for_agent,
    use_for_coder: !!r.use_for_coder,
    use_for_general: !!r.use_for_general,
    is_default: !!r.is_default,
    extra: parseJson<Record<string, unknown>>(r.extra, {}),
    fallback_provider_id: r.fallback_provider_id ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function normalizeStoredLevels(levels: unknown[] | null): string[] | null {
  if (!levels) return null;
  const result: string[] = [];
  for (const lv of levels) {
    if (typeof lv === 'string') {
      result.push(lv);
    } else if (lv && typeof lv === 'object' && 'effort' in lv && typeof (lv as Record<string, unknown>).effort === 'string') {
      result.push((lv as Record<string, unknown>).effort as string);
    }
  }
  return result.length > 0 ? result : null;
}

export function hydrateModel(r: ProviderModelRaw): ProviderModel {
  return {
    provider_id: r.provider_id,
    model_id: r.model_id,
    mode: r.mode,
    name: r.name,
    context_window: r.context_window,
    default_max_tokens: r.default_max_tokens,
    can_reason: !!r.can_reason,
    supports_attachments: !!r.supports_attachments,
    enabled: !!r.enabled,
    source: r.source,
    updated_at: r.updated_at,
    display_name: r.display_name,
    description: r.description,
    default_reasoning_level: r.default_reasoning_level,
    supported_reasoning_levels: normalizeStoredLevels(parseJson<unknown[] | null>(r.supported_reasoning_levels, null)),
    apply_patch_tool_type: r.apply_patch_tool_type,
    available_in_plans: parseJson<string[] | null>(r.available_in_plans, null),
    minimal_client_version: r.minimal_client_version,
    visibility: r.visibility,
    supported_in_api: r.supported_in_api === null ? null : !!r.supported_in_api,
    input_modalities: parseJson<string[] | null>(r.input_modalities, null),
    max_tools: r.max_tools ?? null,
  };
}

export function hydrateOAuth(r: OAuthTokenRaw): OAuthTokenRow {
  return {
    provider_id: r.provider_id,
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: r.expires_at,
    scope: r.scope,
    extra: parseJson<Record<string, unknown>>(r.extra, {}),
    updated_at: r.updated_at,
  };
}

export function hydrateEmbedding(r: EmbeddingConfigRaw): EmbeddingConfigRow {
  return {
    id: r.id,
    kind: r.kind as EmbeddingKind,
    name: r.name,
    enabled: !!r.enabled,
    is_default: !!r.is_default,
    config: parseJson<Record<string, unknown>>(r.config, {}),
    updated_at: r.updated_at,
  };
}

export function hydrateVectorStore(r: VectorStoreConfigRaw): VectorStoreConfigRow {
  return {
    id: r.id,
    kind: r.kind as VectorStoreKind,
    name: r.name,
    enabled: !!r.enabled,
    is_default: !!r.is_default,
    config: parseJson<Record<string, unknown>>(r.config, {}),
    updated_at: r.updated_at,
  };
}

export function hydrateReranker(r: RerankerConfigRaw): RerankerConfigRow {
  return {
    id: r.id,
    kind: r.kind as RerankerKind,
    name: r.name,
    enabled: !!r.enabled,
    is_default: !!r.is_default,
    config: parseJson<Record<string, unknown>>(r.config, {}),
    updated_at: r.updated_at,
  };
}
