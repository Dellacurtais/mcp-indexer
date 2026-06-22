/**
 * Single source of truth for the project version.
 *
 * Reads `version` from the nearest package.json by walking up from this
 * module's location. Resolved once at module load. Works in both compiled
 * (dist/) and tsx dev mode because both live inside the project tree.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

export const VERSION = resolveVersion();
export const PACKAGE_NAME = 'code-context';
