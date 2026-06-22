/**
 * Per-subsystem subdirectories under the canonical MCP data dir
 * (`mcpDataDir()` → `~/.mcp-code-indexer`, overridable via `MCP_DATA_DIR`).
 *
 * Single source of truth so features stop hardcoding
 * `join(process.cwd(), 'data', …)` — which scattered runtime state into
 * the project root instead of the user's home. Operator overrides for
 * the bind-mounted dirs are honored here too, so the HTTP routes and the
 * sandbox manager always agree on the same path.
 */
import { join, resolve } from 'node:path';
import { mcpDataDir } from './config.js';

/**
 * Base dir for per-session virtual-project workdirs. Honors
 * `MCP_SANDBOX_WORKDIR_HOST_DIR` (operators relocate the bind-mount root).
 */
export function virtualProjectsBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MCP_SANDBOX_WORKDIR_HOST_DIR?.trim();
  return override ? resolve(override) : join(mcpDataDir(env), 'virtual-projects');
}

/** Workdir for a single session/project id. */
export function virtualProjectDir(
  id: string | number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(virtualProjectsBaseDir(env), String(id));
}

/**
 * Base dir for global (multi-project) session workspaces — one subdir per
 * global session holding directory junctions/symlinks to each linked project.
 */
export function globalWorkspacesBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpDataDir(env), 'global-workspaces');
}

/** The virtual union dir for a single global workspace id. */
export function globalWorkspaceDir(
  id: string | number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(globalWorkspacesBaseDir(env), String(id));
}

/** Uploaded Design System theme zips. */
export function designSystemUploadsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpDataDir(env), 'design-system-uploads');
}

/** Installed Design System MCP servers (one slot per session id). */
export function designSystemMcpDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpDataDir(env), 'design-system-mcp');
}

/**
 * Sandbox workdir archives (`<dir>/<sessionId>.tar`). Honors
 * `MCP_SANDBOX_ARCHIVE_DIR`.
 */
export function sandboxArchiveDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MCP_SANDBOX_ARCHIVE_DIR?.trim();
  return override ? resolve(override) : join(mcpDataDir(env), 'sandboxes');
}

/**
 * Verdaccio registry storage. The `MCP_VERDACCIO_STORAGE_DIR` override
 * (absolute-only, validated) stays in `verdaccio/storage-paths.ts`; this
 * is just the default location.
 */
export function verdaccioStorageDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpDataDir(env), 'packages');
}

/** Persisted QA (Playwright) report artifacts. */
export function qaReportsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpDataDir(env), 'qa-reports');
}

/** Managed LSP server installs — `<dataDir>/lsp-servers/<id>@<version>/`. */
export function lspServersBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpDataDir(env), 'lsp-servers');
}
