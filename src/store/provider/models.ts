import type { Database as DB } from 'better-sqlite3';
import type { ProviderModel, UpsertModelInput } from './types.js';
import { hydrateModel, type ProviderModelRaw } from './hydrators.js';

export function list(db: DB, providerId: string, onlyEnabled = false): ProviderModel[] {
  const where = onlyEnabled ? 'AND enabled = 1' : '';
  const rows = db
    .prepare(`SELECT * FROM provider_models WHERE provider_id = ? ${where} ORDER BY name, mode`)
    .all(providerId) as ProviderModelRaw[];
  return rows.map(hydrateModel);
}

/** Every model row across all providers. Used to hydrate the capability cache on startup. */
export function listAll(db: DB): ProviderModel[] {
  const rows = db
    .prepare('SELECT * FROM provider_models ORDER BY provider_id, name, mode')
    .all() as ProviderModelRaw[];
  return rows.map(hydrateModel);
}

/**
 * Bulk replace models for a provider, scoped to a `source` (e.g. 'live' or
 * 'manual'). Existing rows from other sources are untouched.
 *
 * Admin toggles (`enabled`) are preserved across refreshes: when an input row
 * omits `enabled`, we look up the current value by (provider_id, model_id,
 * mode) and reuse it. Newly seen models default to `true`. Pass
 * `enabled: true|false` explicitly to override.
 */
export function replaceFromSource(
  db: DB,
  providerId: string,
  source: string,
  models: UpsertModelInput[],
): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const existingRows = db
      .prepare(
        'SELECT model_id, mode, enabled, default_reasoning_level, max_tools FROM provider_models WHERE provider_id = ? AND source = ?'
      )
      .all(providerId, source) as {
        model_id: string;
        mode: string;
        enabled: number;
        default_reasoning_level: string | null;
        max_tools: number | null;
      }[];
    const existingEnabled = new Map<string, boolean>();
    // Track whether each row existed before (regardless of whether the stored
    // level is null) so we can distinguish "admin explicitly chose auto" (=
    // null, but row existed) from "first time we see the model" (= no entry
    // in this map, fall back to seed default).
    const existingReasoning = new Map<string, string | null>();
    // max_tools is admin-set and live discovery never supplies it — without
    // this preservation every refresh would wipe the admin's cap.
    const existingMaxTools = new Map<string, number | null>();
    for (const row of existingRows) {
      const key = `${row.model_id}|${row.mode}`;
      existingEnabled.set(key, !!row.enabled);
      existingReasoning.set(key, row.default_reasoning_level);
      existingMaxTools.set(key, row.max_tools);
    }

    db
      .prepare('DELETE FROM provider_models WHERE provider_id = ? AND source = ?')
      .run(providerId, source);

    const insert = db.prepare(
      `INSERT INTO provider_models
         (provider_id, model_id, mode, name, context_window, default_max_tokens,
          can_reason, supports_attachments, enabled, source, updated_at,
          display_name, description, default_reasoning_level,
          supported_reasoning_levels, apply_patch_tool_type, available_in_plans,
          minimal_client_version, visibility, supported_in_api, input_modalities,
          max_tools)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, model_id, mode) DO UPDATE SET
         name = excluded.name,
         context_window = excluded.context_window,
         default_max_tokens = excluded.default_max_tokens,
         can_reason = excluded.can_reason,
         supports_attachments = excluded.supports_attachments,
         enabled = excluded.enabled,
         source = excluded.source,
         updated_at = excluded.updated_at,
         display_name = excluded.display_name,
         description = excluded.description,
         default_reasoning_level = excluded.default_reasoning_level,
         supported_reasoning_levels = excluded.supported_reasoning_levels,
         apply_patch_tool_type = excluded.apply_patch_tool_type,
         available_in_plans = excluded.available_in_plans,
         minimal_client_version = excluded.minimal_client_version,
         visibility = excluded.visibility,
         supported_in_api = excluded.supported_in_api,
         input_modalities = excluded.input_modalities,
         max_tools = excluded.max_tools`
    );
    for (const m of models) {
      const mode = m.mode ?? '';
      const key = `${m.model_id}|${mode}`;
      const prev = existingEnabled.get(key);
      const finalEnabled = m.enabled ?? prev ?? m.default_enabled ?? true;
      // If a row existed before, the admin's pick (or explicit `auto` = null)
      // wins over the seed value — same policy as `enabled`.
      const finalReasoningLevel = existingReasoning.has(key)
        ? existingReasoning.get(key) ?? null
        : m.default_reasoning_level ?? null;
      const finalMaxTools = existingMaxTools.has(key)
        ? existingMaxTools.get(key) ?? null
        : m.max_tools ?? null;
      insert.run(
        providerId,
        m.model_id,
        mode,
        m.name,
        m.context_window ?? null,
        m.default_max_tokens ?? null,
        m.can_reason ? 1 : 0,
        m.supports_attachments ? 1 : 0,
        finalEnabled ? 1 : 0,
        m.source ?? source,
        now,
        m.display_name ?? null,
        m.description ?? null,
        finalReasoningLevel,
        m.supported_reasoning_levels ? JSON.stringify(m.supported_reasoning_levels) : null,
        m.apply_patch_tool_type ?? null,
        m.available_in_plans ? JSON.stringify(m.available_in_plans) : null,
        m.minimal_client_version ?? null,
        m.visibility ?? null,
        m.supported_in_api === null || m.supported_in_api === undefined
          ? null
          : m.supported_in_api ? 1 : 0,
        m.input_modalities ? JSON.stringify(m.input_modalities) : null,
        finalMaxTools
      );
    }
  });
  tx();
}

export function update(
  db: DB,
  providerId: string,
  modelId: string,
  mode: string,
  patch: {
    enabled?: boolean;
    name?: string;
    default_reasoning_level?: string | null;
    context_window?: number | null;
    max_tools?: number | null;
  },
): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); args.push(patch.enabled ? 1 : 0); }
  if (patch.name !== undefined) { sets.push('name = ?'); args.push(patch.name); }
  if (patch.default_reasoning_level !== undefined) {
    sets.push('default_reasoning_level = ?');
    args.push(patch.default_reasoning_level);
  }
  if (patch.context_window !== undefined) {
    sets.push('context_window = ?');
    args.push(patch.context_window);
  }
  if (patch.max_tools !== undefined) {
    sets.push('max_tools = ?');
    args.push(patch.max_tools);
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  args.push(providerId, modelId, mode);
  db
    .prepare(`UPDATE provider_models SET ${sets.join(', ')} WHERE provider_id = ? AND model_id = ? AND mode = ?`)
    .run(...args);
}

/**
 * Delete a single MANUAL model row. Scoped to `source='manual'` so live or
 * seeded rows can't be removed here (they'd reappear on the next refresh
 * anyway — the admin disables those via the `enabled` toggle instead).
 * Returns the number of rows deleted (0 = nothing matched).
 */
export function remove(db: DB, providerId: string, modelId: string, mode: string): number {
  const r = db
    .prepare(
      `DELETE FROM provider_models WHERE provider_id = ? AND model_id = ? AND mode = ? AND source = 'manual'`,
    )
    .run(providerId, modelId, mode);
  return r.changes;
}

/**
 * Backfill context_window for every model row that has it null. Pulls the
 * value from the static registry's prefix-aware lookup. Cheap, idempotent,
 * no network.
 */
export function backfillContextWindows(
  db: DB,
  lookup: (modelId: string) => number | null,
): { updated: number; still_null: number; total: number } {
  const rows = db
    .prepare(`SELECT provider_id, model_id, mode, context_window FROM provider_models`)
    .all() as Array<{ provider_id: string; model_id: string; mode: string; context_window: number | null }>;
  let updated = 0;
  let stillNull = 0;
  const stmt = db.prepare(
    `UPDATE provider_models SET context_window = ?, updated_at = datetime('now')
      WHERE provider_id = ? AND model_id = ? AND mode = ?`,
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (r.context_window != null) continue;
      const cw = lookup(r.model_id);
      if (cw != null) {
        stmt.run(cw, r.provider_id, r.model_id, r.mode);
        updated++;
      } else {
        stillNull++;
      }
    }
  });
  tx();
  return { updated, still_null: stillNull, total: rows.length };
}
