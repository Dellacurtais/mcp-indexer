/**
 * Resolve (and create) the on-disk cache dir for local ONNX models — shared by
 * the local embedder and the local reranker. Zero-config by default.
 *
 * Priority:
 *   1. explicit arg          — an admin config `cacheDir`
 *   2. MCP_MODEL_CACHE_DIR   — Electron sets this to `userData/models` so the
 *                              cache survives app updates / asar repacking
 *   3. ~/.mcp/models         — auto: derived from the OS home dir, no setup
 *
 * The directory is created if missing (best-effort) so transformers.js can
 * write the downloaded model into it on first use.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function resolveModelCacheDir(explicit?: string): string {
  const dir = explicit || process.env.MCP_MODEL_CACHE_DIR || join(homedir(), '.mcp', 'models');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort: if creation fails (perms, read-only FS), transformers.js
    // falls back to its own default cache — never block model loading on this.
  }
  return dir;
}
