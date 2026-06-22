import type { Database as DB } from 'better-sqlite3';
import type { RerankerConfigRow, RerankerKind } from './types.js';
import { hydrateReranker, type RerankerConfigRaw } from './hydrators.js';

export interface UpsertRerankerInput {
  id: string;
  kind: RerankerKind;
  name: string;
  enabled?: boolean;
  is_default?: boolean;
  config?: Record<string, unknown>;
}

export function list(db: DB): RerankerConfigRow[] {
  const rows = db
    .prepare('SELECT * FROM reranker_configs ORDER BY name')
    .all() as RerankerConfigRaw[];
  return rows.map(hydrateReranker);
}

export function getDefault(db: DB): RerankerConfigRow | null {
  const row = db
    .prepare('SELECT * FROM reranker_configs WHERE is_default = 1 AND enabled = 1 LIMIT 1')
    .get() as RerankerConfigRaw | undefined;
  return row ? hydrateReranker(row) : null;
}

export function upsert(db: DB, input: UpsertRerankerInput): RerankerConfigRow {
  db
    .prepare(
      `INSERT INTO reranker_configs (id, kind, name, enabled, is_default, config, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         name = excluded.name,
         enabled = excluded.enabled,
         is_default = excluded.is_default,
         config = excluded.config,
         updated_at = excluded.updated_at`
    )
    .run(
      input.id,
      input.kind,
      input.name,
      (input.enabled ?? false) ? 1 : 0,
      (input.is_default ?? false) ? 1 : 0,
      JSON.stringify(input.config ?? {})
    );

  if (input.is_default) {
    db
      .prepare('UPDATE reranker_configs SET is_default = 0 WHERE id != ? AND is_default = 1')
      .run(input.id);
  }

  return list(db).find((c) => c.id === input.id)!;
}
