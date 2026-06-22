/**
 * Per-project vectors split (R2) — move ONE project's code+snapshot vectors out
 * of the central `vectors-sqlite-vec.db` into its own `<root>/.mcp-indexer/
 * vectors.db`, preserving vid. Docs (no project_name) stay central.
 *
 * NON-FATAL by contract: any failure returns {status:'pending'} (re-embeddable)
 * and deletes the partial file — it must NEVER block the relational flip. The
 * central rows are left intact (deferred purge, mirroring the relational split),
 * so a failed vector split degrades to "code RAG still served from central".
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECT_VECTORS_FILENAME } from '../project-db/paths.js';
import {
  openVecConn, vecTableExists, readOutProjectVectors, reinsertVectors,
  countAllVectors, countProjectVectors, type VecDB,
} from './vectors-io.js';

/** The central vec store lives beside the central index.db (defaultSqliteVecPath). */
const CENTRAL_VECTORS_FILENAME = 'vectors-sqlite-vec.db';

export function centralVectorsPath(centralDbPath: string): string {
  return join(dirname(centralDbPath), CENTRAL_VECTORS_FILENAME);
}

export function projectVectorsPath(projectDbPath: string): string {
  return join(dirname(projectDbPath), PROJECT_VECTORS_FILENAME);
}

export interface VectorsSplitOutcome {
  status: 'done' | 'skipped' | 'pending';
  reason?: string;
  copied?: number;
}

export interface VectorsSplitDeps {
  centralVectorsPath: string;
  projectVectorsPath: string;
  /** The project's name — the tenant key stamped on its code+snapshot vectors. */
  projectName: string;
  /** vector_ids row count in the project index.db (soft cross-check only). */
  trackedVectorIds?: number;
}

export interface VecParity {
  ok: boolean;
  reason?: string;
  proj: number;
  central: number;
}

/**
 * Copy-correctness gate: the project store must hold exactly the central rows
 * for this project_name, and pass a structural quick_check. `trackedVectorIds`
 * is a soft cross-check (pending remote-deletes can leave a transient gap) —
 * logged, not gated, so it never fails an otherwise-faithful copy.
 */
export function verifyVectorParity(proj: VecDB, central: VecDB, projectName: string): VecParity {
  const p = countAllVectors(proj);
  const c = countProjectVectors(central, projectName);
  if (p !== c) return { ok: false, reason: `count proj=${p} central=${c}`, proj: p, central: c };
  try {
    const q = proj.pragma('quick_check', { simple: true });
    if (q !== 'ok') return { ok: false, reason: `quick_check ${String(q)}`, proj: p, central: c };
  } catch { /* pragma unsupported — rely on the count parity */ }
  return { ok: true, proj: p, central: c };
}

function removeVecFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { if (existsSync(path + suffix)) rmSync(path + suffix, { force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Run (or retry) the vectors split for one project. Idempotent on a fresh file —
 * deletes any partial project vectors.db first. Returns 'done' when the project
 * has no vectors to move (no central file/table/rows) so the caller can mark the
 * marker complete without a useless retry loop.
 */
export async function splitProjectVectors(deps: VectorsSplitDeps): Promise<VectorsSplitOutcome> {
  if (!existsSync(deps.centralVectorsPath)) return { status: 'done', reason: 'no central vectors file', copied: 0 };

  removeVecFiles(deps.projectVectorsPath); // fresh start — discard a crashed partial
  let central: VecDB | null = null;
  let proj: VecDB | null = null;
  try {
    central = await openVecConn(deps.centralVectorsPath, { readonly: true });
    if (!vecTableExists(central)) return { status: 'done', reason: 'no vectors table', copied: 0 };

    const rows = readOutProjectVectors(central, deps.projectName);
    if (rows.length === 0) return { status: 'done', reason: 'no project vectors', copied: 0 };

    proj = await openVecConn(deps.projectVectorsPath);
    const copied = reinsertVectors(proj, rows);
    const parity = verifyVectorParity(proj, central, deps.projectName);
    if (!parity.ok) {
      proj.close(); proj = null;
      removeVecFiles(deps.projectVectorsPath);
      return { status: 'pending', reason: `parity: ${parity.reason}` };
    }
    return { status: 'done', copied };
  } catch (e) {
    if (proj) { try { proj.close(); } catch { /* ignore */ } proj = null; }
    removeVecFiles(deps.projectVectorsPath);
    return { status: 'pending', reason: (e as Error).message };
  } finally {
    try { proj?.close(); } catch { /* ignore */ }
    try { central?.close(); } catch { /* ignore */ }
  }
}
