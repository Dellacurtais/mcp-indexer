import type { DiscoveredModel } from '@ctx/shared/types.js';
import type { DB } from './types.js';

const FRESH_MS = 24 * 60 * 60 * 1000;

export function get(db: DB, provider: string): DiscoveredModel[] | null {
  const row = db.prepare('SELECT * FROM models_cache WHERE provider = ?')
    .get(provider) as { models: string; fetched_at: string } | undefined;
  if (!row) return null;

  const fetchedAt = new Date(row.fetched_at + 'Z').getTime();
  const now = Date.now();
  if (now - fetchedAt > FRESH_MS) return null;

  return JSON.parse(row.models) as DiscoveredModel[];
}

export function set(db: DB, provider: string, models: DiscoveredModel[]): void {
  db.prepare(`
    INSERT INTO models_cache (provider, models, fetched_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(provider) DO UPDATE SET models = excluded.models, fetched_at = excluded.fetched_at
  `).run(provider, JSON.stringify(models));
}
