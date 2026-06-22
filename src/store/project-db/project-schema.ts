/**
 * Schema bootstrap for a per-project DB.
 *
 * A project DB reuses the SAME schema as the central DB — the single generated
 * baseline applied by `initSchema` (see db/schema/baseline.ts). `runMigrations`
 * is a retained no-op (the historical migration lineage was collapsed into the
 * baseline). The ROUTING layer decides which file a given table's rows are
 * written to. Safe on a fresh empty file: it is exactly what a brand-new central
 * install runs.
 *
 * (The upstream per-project schema-trim pass — which dropped central-only tables
 * — is not vendored here: the baseline is already pruned to the retrieval set, so
 * there is nothing to trim.)
 */
import type { DB } from '../db/types.js';
import { initSchema } from '../db/schema/index.js';
import { runMigrations, getSchemaVersion } from '../migrations/index.js';

export function initProjectSchema(db: DB): void {
  initSchema(db);
  runMigrations(db);
}

export function getProjectSchemaVersion(db: DB): number {
  return getSchemaVersion(db);
}
