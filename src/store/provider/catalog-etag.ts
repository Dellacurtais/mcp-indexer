import type { Database as DB } from 'better-sqlite3';
import * as providers from './providers.js';

/**
 * ETag from the last live model-catalog refresh, stored under
 * `provider_configs.extra.catalog_etag`. The Codex `/models` endpoint
 * returns an ETag we can replay via `If-None-Match` to short-circuit
 * with a 304 when nothing changed.
 */
export function get(db: DB, providerId: string): string | null {
  const cfg = providers.get(db, providerId);
  if (!cfg) return null;
  const value = cfg.extra?.catalog_etag;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function set(db: DB, providerId: string, etag: string | null): void {
  const cfg = providers.get(db, providerId);
  if (!cfg) return;
  const nextExtra = { ...cfg.extra };
  if (etag === null || etag === '') delete nextExtra.catalog_etag;
  else nextExtra.catalog_etag = etag;
  db
    .prepare('UPDATE provider_configs SET extra = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(nextExtra), new Date().toISOString(), providerId);
}
