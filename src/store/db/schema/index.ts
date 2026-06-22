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
}
