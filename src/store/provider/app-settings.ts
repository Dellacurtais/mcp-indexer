import type { Database as DB } from 'better-sqlite3';
import * as providers from './providers.js';
import * as models from './models.js';

// ─── KV ──────────────────────────────────────────────────────────

export function getAppSetting(db: DB, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setAppSetting(db: DB, key: string, value: string): void {
  db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, new Date().toISOString());
}

// ─── General AI Default ──────────────────────────────────────────

/**
 * Resolve the provider+model to use for "general AI" utilities.
 *
 * Priority:
 *   1. Operator-pinned selection stored in `app_settings['general_default_model']`
 *      (as JSON `{ providerId, modelId }`). Only returned if the provider is
 *      still enabled and the model is still enabled.
 *   2. First enabled provider with at least one enabled model.
 *   3. `null` when no provider is eligible.
 *
 * The legacy `use_for_general` flag is no longer consulted — earlier
 * iterations required it but the flag wasn't discoverable in the UI.
 */
export function getGeneralDefault(db: DB): { providerId: string; modelId: string } | null {
  const pinned = getAppSetting(db, 'general_default_model');
  if (pinned) {
    try {
      const parsed = JSON.parse(pinned) as { providerId?: string; modelId?: string };
      if (parsed.providerId && parsed.modelId) {
        const prov = providers.get(db, parsed.providerId);
        if (prov && prov.enabled) {
          const model = models.list(db, prov.id, true).find((m) => m.model_id === parsed.modelId);
          if (model) return { providerId: prov.id, modelId: model.model_id };
        }
      }
    } catch { /* fall through to heuristic */ }
  }
  // Heuristic fallback — first enabled provider with at least one enabled model.
  const candidates = providers.list(db, { enabled: true });
  for (const p of candidates) {
    const m = models.list(db, p.id, true)[0];
    if (m) return { providerId: p.id, modelId: m.model_id };
  }
  return null;
}

export function setGeneralDefault(db: DB, providerId: string, modelId: string): void {
  setAppSetting(db, 'general_default_model', JSON.stringify({ providerId, modelId }));
}

// ─── Fallback Chain ──────────────────────────────────────────────

/**
 * Walk the fallback_provider_id chain starting from `providerId`. Returns an
 * ordered list of {provider, model} entries for fallback. Stops at null,
 * cycles, or max depth (10) to prevent infinite loops.
 */
export function getFallbackChain(db: DB, providerId: string): Array<{ provider: string; model: string }> {
  const chain: Array<{ provider: string; model: string }> = [];
  const visited = new Set<string>();
  let currentId: string | null = providerId;
  const maxDepth = 10;

  for (let i = 0; i < maxDepth && currentId; i++) {
    const cfg = providers.get(db, currentId);
    if (!cfg || !cfg.fallback_provider_id) break;

    const fallbackId = cfg.fallback_provider_id;
    if (visited.has(fallbackId)) break;
    visited.add(fallbackId);

    const fallbackCfg = providers.get(db, fallbackId);
    if (!fallbackCfg || !fallbackCfg.enabled) break;

    const modelList = models.list(db, fallbackId);
    const defaultModel = modelList[0];
    if (!defaultModel) break;

    chain.push({ provider: fallbackId, model: defaultModel.model_id });
    currentId = fallbackId;
  }

  return chain;
}

export function setFallbackProvider(db: DB, providerId: string, fallbackProviderId: string | null): void {
  db
    .prepare('UPDATE provider_configs SET fallback_provider_id = ?, updated_at = ? WHERE id = ?')
    .run(fallbackProviderId, new Date().toISOString(), providerId);
}
