/**
 * ATTACH-based federation for cross-project reads.
 *
 * SQLite caps attached DBs per connection at `SQLITE_MAX_ATTACHED` (default 10).
 * `withAttachedProjects` attaches a small batch onto a (short-lived, read-only)
 * central connection, runs a read-only query across them, then detaches. For
 * more projects than the cap, use `fanOutProjects` (attach-batch.ts).
 *
 * Caveats encoded here:
 *  - ATTACH/DETACH are forbidden inside an open transaction → we assert no tx.
 *  - `foreign_keys` cannot be toggled inside a tx; we turn it OFF (reads only,
 *    and avoids cross-schema FK edge cases) on a fresh connection with no tx.
 *  - Aliases are generated (`p<id>`) — never derived from input — because an
 *    ATTACH alias identifier cannot be parameterized. The path IS bound as `?`.
 */
import type { DB } from '../db/types.js';
import { AttachLimitError } from './errors.js';

/** Conservative batch size, < the default SQLITE_MAX_ATTACHED (10). */
export const ATTACH_BATCH = 8;

export interface AttachTarget {
  projectId: number;
  dbPath: string;
  /** Generated identifier, e.g. `p123`. Must be a safe SQL identifier. */
  alias: string;
}

/** Build a safe, generated alias for a project id. */
export function aliasFor(projectId: number): string {
  return `p${projectId}`;
}

export function withAttachedProjects<T>(
  central: DB,
  targets: AttachTarget[],
  fn: (db: DB, aliases: string[]) => T,
): T {
  if (targets.length > ATTACH_BATCH) {
    throw new AttachLimitError(targets.length, ATTACH_BATCH);
  }
  if (central.inTransaction) {
    throw new Error('withAttachedProjects must run outside a transaction');
  }

  const fkWasOn = central.pragma('foreign_keys', { simple: true }) === 1;
  if (fkWasOn) central.pragma('foreign_keys = OFF');

  const attached: string[] = [];
  try {
    for (const t of targets) {
      // alias is generated (validated by aliasFor); dbPath is bound as a param.
      central.prepare(`ATTACH DATABASE ? AS ${t.alias}`).run(t.dbPath);
      attached.push(t.alias);
    }
    return fn(central, attached);
  } finally {
    for (const alias of attached.reverse()) {
      try {
        central.exec(`DETACH DATABASE ${alias}`);
      } catch {
        /* best-effort detach */
      }
    }
    if (fkWasOn) central.pragma('foreign_keys = ON');
  }
}
