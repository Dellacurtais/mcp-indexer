import type { Database as DB } from 'better-sqlite3';
import * as providers from './providers.js';

export function getTarget(db: DB, providerId: string): { providerId: string; modelId: string | null } | null {
  const cfg = providers.get(db, providerId);
  if (!cfg) return null;
  const targetProvider = cfg.extra?.subagent_provider_id;
  const provider = typeof targetProvider === 'string' && targetProvider.length > 0
    ? targetProvider
    : providerId;
  const model = getModel(db, providerId);
  if (provider === providerId && !model) return null;
  return { providerId: provider, modelId: model };
}

export function getModel(db: DB, providerId: string): string | null {
  const cfg = providers.get(db, providerId);
  if (!cfg) return null;
  const value = cfg.extra?.subagent_model;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function setModel(db: DB, providerId: string, modelId: string | null): void {
  const current = getTarget(db, providerId);
  setTarget(db, providerId, current?.providerId ?? providerId, modelId);
}

export function setTarget(
  db: DB,
  providerId: string,
  targetProviderId: string | null,
  modelId: string | null,
): void {
  const cfg = providers.get(db, providerId);
  if (!cfg) return;
  const nextExtra = { ...cfg.extra };
  if (!targetProviderId || targetProviderId === providerId) delete nextExtra.subagent_provider_id;
  else nextExtra.subagent_provider_id = targetProviderId;
  if (modelId === null || modelId === '') delete nextExtra.subagent_model;
  else nextExtra.subagent_model = modelId;
  db
    .prepare('UPDATE provider_configs SET extra = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(nextExtra), new Date().toISOString(), providerId);
}
