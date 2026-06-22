/**
 * Schema bootstrap for a per-project DB.
 *
 * P0 strategy (de-risked): a project DB reuses the SAME schema as the central
 * DB — `initSchema` + the central migration lineage. Both DBs therefore carry
 * the full schema; the ROUTING layer decides which file a given table's rows
 * are written to. This avoids hand-authoring a separate baseline that could
 * drift from the real schema. Trimming the project DB to project-only tables
 * (and the central DB to central-only tables) is a later, separately-shipped
 * cleanup (see plan §6.6 / P3-P6) — when it lands, only THIS file changes to
 * point at a dedicated project-migration lineage.
 *
 * Safe on a fresh empty file: it is exactly what a brand-new central install
 * runs, so every migration is already proven to apply to an empty DB.
 *
 * C2: after the full schema is built + verified, `trimProjectSchema` drops the
 * ~93 central-only tables this inherits and recreates the project tables that
 * carry a cross-DB FK without it — leaving a project-only DB. It is a no-op when
 * the trim flag is off (byte-identical to today) and is keyed off its own marker
 * (idempotent). This is the ONLY place trim runs, and it only ever sees a
 * per-project DB — the central DB opens via the CodeIndexDB constructor, never
 * here, so trim is structurally unreachable from the central path.
 */
import type { DB } from '../db/types.js';
import { initSchema } from '../db/schema/index.js';
import { runMigrations, getSchemaVersion } from '../migrations/index.js';
import { trimProjectSchema } from './trim/index.js';

export function initProjectSchema(db: DB): void {
  initSchema(db);
  runMigrations(db);
  trimProjectSchema(db);
}

export function getProjectSchemaVersion(db: DB): number {
  return getSchemaVersion(db);
}
