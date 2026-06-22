import type { Database as DB } from 'better-sqlite3';
import type { ProviderConfig, UpsertProviderInput } from './types.js';
import { hydrateProvider, type ProviderConfigRaw } from './hydrators.js';
import * as models from './models.js';

export interface ListProvidersFilter {
  use_for_coder?: boolean;
  use_for_agent?: boolean;
  use_for_general?: boolean;
  enabled?: boolean;
}

export function list(db: DB, filter?: ListProvidersFilter): ProviderConfig[] {
  const clauses: string[] = [];
  if (filter?.enabled !== undefined) clauses.push(`enabled = ${filter.enabled ? 1 : 0}`);
  if (filter?.use_for_coder !== undefined) clauses.push(`use_for_coder = ${filter.use_for_coder ? 1 : 0}`);
  if (filter?.use_for_agent !== undefined) clauses.push(`use_for_agent = ${filter.use_for_agent ? 1 : 0}`);
  if (filter?.use_for_general !== undefined) clauses.push(`use_for_general = ${filter.use_for_general ? 1 : 0}`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM provider_configs ${where} ORDER BY name`)
    .all() as ProviderConfigRaw[];
  return rows.map(hydrateProvider);
}

/**
 * Return the default enabled provider, or the first enabled provider if none
 * is explicitly marked as default. Returns null when no providers are configured.
 */
export function getDefault(db: DB): ProviderConfig | null {
  const row = db
    .prepare('SELECT * FROM provider_configs WHERE is_default = 1 AND enabled = 1 LIMIT 1')
    .get() as ProviderConfigRaw | undefined;
  if (row) return hydrateProvider(row);
  const first = db
    .prepare('SELECT * FROM provider_configs WHERE enabled = 1 ORDER BY name LIMIT 1')
    .get() as ProviderConfigRaw | undefined;
  return first ? hydrateProvider(first) : null;
}

/**
 * Convenience: return `{ kind, model }` for the default provider, picking
 * the first enabled model when available. Returns `{ kind: 'zai', model: undefined }`
 * as ultimate fallback.
 */
export function getDefaultAndModel(db: DB): { kind: string; model: string | undefined } {
  const prov = getDefault(db);
  if (!prov) return { kind: 'zai', model: undefined };
  const list = models.list(db, prov.id, true);
  return { kind: prov.kind, model: list[0]?.model_id };
}

export function get(db: DB, id: string): ProviderConfig | null {
  const row = db
    .prepare('SELECT * FROM provider_configs WHERE id = ?')
    .get(id) as ProviderConfigRaw | undefined;
  return row ? hydrateProvider(row) : null;
}

export function upsert(db: DB, input: UpsertProviderInput): ProviderConfig {
  const now = new Date().toISOString();
  const existing = get(db, input.id);

  if (existing) {
    db
      .prepare(
        `UPDATE provider_configs SET
           name = ?, kind = ?, base_url = ?, api_key = ?, auth_mode = ?,
           enabled = ?, use_for_agent = ?, use_for_coder = ?, use_for_general = ?, is_default = ?,
           extra = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.name,
        input.kind,
        input.base_url ?? null,
        input.api_key ?? null,
        input.auth_mode ?? 'api_key',
        (input.enabled ?? existing.enabled) ? 1 : 0,
        (input.use_for_agent ?? existing.use_for_agent) ? 1 : 0,
        (input.use_for_coder ?? existing.use_for_coder) ? 1 : 0,
        (input.use_for_general ?? existing.use_for_general) ? 1 : 0,
        (input.is_default ?? existing.is_default) ? 1 : 0,
        JSON.stringify(input.extra ?? existing.extra),
        now,
        input.id
      );
  } else {
    db
      .prepare(
        `INSERT INTO provider_configs
           (id, name, kind, base_url, api_key, auth_mode, enabled,
            use_for_agent, use_for_coder, use_for_general, is_default, extra, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.name,
        input.kind,
        input.base_url ?? null,
        input.api_key ?? null,
        input.auth_mode ?? 'api_key',
        (input.enabled ?? true) ? 1 : 0,
        (input.use_for_agent ?? true) ? 1 : 0,
        (input.use_for_coder ?? true) ? 1 : 0,
        (input.use_for_general ?? false) ? 1 : 0,
        (input.is_default ?? false) ? 1 : 0,
        JSON.stringify(input.extra ?? {}),
        now,
        now
      );
  }

  // Enforce single default per (scope). Cheap: only touched on upsert.
  if (input.is_default) {
    db
      .prepare('UPDATE provider_configs SET is_default = 0 WHERE id != ? AND is_default = 1')
      .run(input.id);
  }

  return get(db, input.id)!;
}

export function del(db: DB, id: string): void {
  db.prepare('DELETE FROM provider_configs WHERE id = ?').run(id);
}
