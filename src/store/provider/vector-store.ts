import type { Database as DB } from 'better-sqlite3';
import type { VectorStoreConfigRow, VectorStoreKind } from './types.js';
import { hydrateVectorStore, type VectorStoreConfigRaw } from './hydrators.js';

export interface UpsertVectorStoreInput {
  id: string;
  kind: VectorStoreKind;
  name: string;
  enabled?: boolean;
  is_default?: boolean;
  config?: Record<string, unknown>;
}

export function list(db: DB): VectorStoreConfigRow[] {
  const rows = db
    .prepare('SELECT * FROM vector_store_configs ORDER BY name')
    .all() as VectorStoreConfigRaw[];
  return rows.map(hydrateVectorStore);
}

export function getDefault(db: DB): VectorStoreConfigRow | null {
  const row = db
    .prepare('SELECT * FROM vector_store_configs WHERE is_default = 1 AND enabled = 1 LIMIT 1')
    .get() as VectorStoreConfigRaw | undefined;
  return row ? hydrateVectorStore(row) : null;
}

export function upsert(db: DB, input: UpsertVectorStoreInput): VectorStoreConfigRow {
  db
    .prepare(
      `INSERT INTO vector_store_configs (id, kind, name, enabled, is_default, config, updated_at)
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
      .prepare('UPDATE vector_store_configs SET is_default = 0 WHERE id != ? AND is_default = 1')
      .run(input.id);
  }

  return list(db).find((c) => c.id === input.id)!;
}
