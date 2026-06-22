/**
 * vec0 read-out / re-insert mechanics for the per-project vectors split (R2).
 *
 * vec0 does NOT support `INSERT ... SELECT` across an ATTACHed DB, so a project's
 * code+snapshot vectors are moved by reading each row's raw embedding bytes out
 * of the central store and re-INSERTing them into the project's own vectors.db,
 * preserving the `vid` (TEXT PK) verbatim so the relational `vector_ids` rows
 * (already moved to the project index.db) keep pointing at the right vector.
 * This is the same proven mechanism the legacy no-namespace migration uses.
 *
 * Self-contained (own better-sqlite3 + sqlite-vec load) so the split engine has
 * no dependency on the SqliteVecVectorStore class.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type DatabaseConstructor from 'better-sqlite3';
import { applyTuningPragmas } from '../db/pragmas.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
export type VecDB = InstanceType<typeof DatabaseConstructor>;

const TABLE = 'vectors';

/** A vec0 row as read back from the central store. `embedding` is the raw
 *  float32 byte blob (a Buffer under better-sqlite3) — re-bound verbatim. */
export interface VecRow {
  vid: string;
  embedding: Buffer;
  namespace: string | null;
  project_name: string | null;
  type: string | null;
  ref_id: string | null;
}

/** Open a raw vec0 connection with the sqlite-vec extension loaded. Caller closes. */
export async function openVecConn(path: string, opts?: { readonly?: boolean }): Promise<VecDB> {
  // The project vectors.db sibling dir may not exist yet — create it (a readonly
  // open never creates a file, so only for writers). better-sqlite3 does NOT
  // mkdir parents like openRawProjectDb does.
  if (!opts?.readonly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { readonly: !!opts?.readonly });
  if (!opts?.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    applyTuningPragmas(db);
  }
  const sqliteVec = (await import('sqlite-vec')) as { load: (db: VecDB) => void };
  sqliteVec.load(db);
  return db;
}

export function vecTableExists(db: VecDB): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(TABLE);
}

/** Filter for a project's movable vectors: CODE vectors only (namespace
 *  `code:<name>`). Snapshot vectors (namespace-less) stay central — their
 *  upsert/search/delete carry no `code:` namespace, so the routing facade
 *  always sends them to the central store; moving them would orphan a live
 *  pointer. Doc vectors (`docs:*`, no project_name) are excluded by both terms. */
const CODE_VECTOR_WHERE = "project_name = ? AND namespace LIKE 'code:%'";

export function readOutProjectVectors(central: VecDB, projectName: string): VecRow[] {
  return central
    .prepare(`SELECT vid, embedding, namespace, project_name, type, ref_id FROM ${TABLE} WHERE ${CODE_VECTOR_WHERE}`)
    .all(projectName) as VecRow[];
}

/**
 * Re-insert rows into a FRESH project vectors.db, preserving vid + raw embedding.
 * The table dimension is derived from the first embedding's byte length (float32,
 * 4 bytes/component). Metadata is coalesced to '' (vec0 0.1.9+ rejects NULL).
 */
export function reinsertVectors(proj: VecDB, rows: VecRow[]): number {
  if (rows.length === 0) return 0;
  const dim = Math.floor(rows[0].embedding.byteLength / 4);
  proj.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING vec0(
       vid TEXT PRIMARY KEY, embedding float[${dim}],
       namespace TEXT, project_name TEXT, type TEXT, ref_id TEXT
     )`,
  );
  const ins = proj.prepare(
    `INSERT INTO ${TABLE}(vid, embedding, namespace, project_name, type, ref_id) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = proj.transaction((rs: VecRow[]) => {
    for (const r of rs) {
      ins.run(r.vid, r.embedding, r.namespace ?? '', r.project_name ?? '', r.type ?? '', r.ref_id ?? '');
    }
  });
  tx(rows);
  return rows.length;
}

export function countProjectVectors(central: VecDB, projectName: string): number {
  return (central.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE ${CODE_VECTOR_WHERE}`).get(projectName) as { n: number }).n;
}

export function countAllVectors(db: VecDB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get() as { n: number }).n;
}
