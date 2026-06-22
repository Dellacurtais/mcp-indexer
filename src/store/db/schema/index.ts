import type { DB } from '../types.js';
import { BASELINE_DDL } from './baseline.js';

/**
 * Create the full schema from the generated baseline (see `baseline.ts`, derived
 * from a fully-migrated index.db and pruned to retrieval + provider + infra
 * tables). Every CREATE uses IF NOT EXISTS, so this is idempotent and safe to
 * call on every `CodeIndexDB` construction.
 */
export function initSchema(db: DB): void {
  db.exec(BASELINE_DDL);
  // Stamp the collapsed-baseline version so getSchemaVersion() is meaningful
  // (the historical migration runner is a no-op). Idempotent.
  db.prepare("INSERT OR IGNORE INTO schema_version (version, name) VALUES (1, 'baseline')").run();
}
