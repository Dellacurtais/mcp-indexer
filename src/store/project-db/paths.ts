/**
 * Resolve where a project's DB files live (tiered-hybrid split).
 *
 *  - Normal:   <root>/.mcp-indexer/index.db   (+ vectors.db)
 *  - Fallback: <mcpDataDir>/projects-db/p<id>/index.db
 *
 * Fallback covers: the user-memory sentinel (id 0) and synthetic global-session
 * union projects (no real root), an empty/missing root, and roots that are not
 * writable (UNC/remote/read-only mounts). The resolved path is persisted to
 * `projects.db_path` by the caller so it stays stable even if the root later
 * moves; this module only COMPUTES the path the first time.
 */
import { accessSync, constants as FS, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mcpDataDir } from '@ctx/shared/utils/config.js';

export const PROJECT_DB_DIRNAME = '.mcp-indexer';
export const PROJECT_DB_FILENAME = 'index.db';
export const PROJECT_VECTORS_FILENAME = 'vectors.db';

export interface ProjectDbLocation {
  /** Directory holding the project DB files (project's `.mcp-indexer/` or fallback). */
  dir: string;
  dbPath: string;
  vectorsPath: string;
  /** True when stored under the central data dir instead of the project root. */
  isFallback: boolean;
}

/** Stable per-id fallback directory under the central data dir. */
export function centralFallbackDir(projectId: number, env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpDataDir(env), 'projects-db', `p${projectId}`);
}

function locationIn(dir: string, isFallback: boolean): ProjectDbLocation {
  return {
    dir,
    dbPath: join(dir, PROJECT_DB_FILENAME),
    vectorsPath: join(dir, PROJECT_VECTORS_FILENAME),
    isFallback,
  };
}

/** Cheap one-shot writability probe; any failure → use the fallback. */
function isWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, FS.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveOpts {
  /** Force the central-dir fallback (tests, read-only roots). */
  forceFallback?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Compute the DB location for a project. Pure-ish: it may `mkdir` the candidate
 * directory while probing, but never writes data. Persist the result to
 * `projects.db_path` and prefer that on subsequent opens.
 */
export function resolveProjectDbLocation(
  projectId: number,
  rootPath: string | null | undefined,
  opts: ResolveOpts = {},
): ProjectDbLocation {
  const env = opts.env ?? process.env;
  const forceAll = (env.MCP_PROJECT_DB_FALLBACK_ALL ?? '').trim() === '1';
  const fallback = (): ProjectDbLocation => locationIn(centralFallbackDir(projectId, env), true);

  // No real root → always fallback (sentinel id 0, synthetic unions).
  if (opts.forceFallback || forceAll || projectId === 0 || !rootPath || !rootPath.trim()) {
    return fallback();
  }

  const dir = join(rootPath, PROJECT_DB_DIRNAME);
  return isWritable(dir) ? locationIn(dir, false) : fallback();
}
