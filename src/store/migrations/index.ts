/**
 * Schema versioning (baseline-only).
 *
 * The code-context server ships a single generated baseline (see
 * `db/schema/baseline.ts`, applied by `initSchema()`), so the historical
 * migration runner is collapsed to a no-op. The `Migration` type is kept
 * because a couple of vendored utilities (e.g. `002_symbol_stable_id`'s
 * `computeStableId`) still live in migration files and import it.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface Migration {
  version: number;
  name: string;
  up(db: DB): void;
}

/** Highest version represented by the baseline schema. */
export function getSchemaVersion(db: DB): number {
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as
      | { v: number | null }
      | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

/**
 * No-op: the full schema is created by `initSchema()` from the generated
 * baseline. Kept for call-site compatibility with `CodeIndexDB`.
 */
export function runMigrations(_db: DB): void {
  /* baseline schema is applied in initSchema(); nothing to migrate */
}
