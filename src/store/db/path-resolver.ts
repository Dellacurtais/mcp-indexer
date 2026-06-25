import { createRequire } from 'node:module';
import type { DB, PathAlias } from './types.js';

const require = createRequire(import.meta.url);

/**
 * Strip `//` and block comments from JSONC, but ONLY outside string literals.
 * A naive block-comment regex corrupts tsconfig path aliases like
 * `"@ctx/shared/*"` — the slash-star inside the string starts a phantom comment
 * that eats to the next close marker, breaking JSON.parse. This scanner respects
 * string literals.
 */
function stripJsonc(src: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  let strCh = '';
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === strCh) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; out += c; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { i += 2; while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

/**
 * Read tsconfig `compilerOptions.paths` aliases from a project root. Tolerates
 * JSONC (strips comments) because tsconfig.json commonly has them. Silently
 * returns `[]` when missing/unreadable so callers can fall back to relative-only.
 */
export function loadTsconfigPathAliases(projectRoot: string): PathAlias[] {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const candidates = ['tsconfig.json', 'jsconfig.json'];
  for (const fname of candidates) {
    const p = path.join(projectRoot, fname);
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(stripJsonc(raw));
      const paths = parsed?.compilerOptions?.paths;
      const baseUrl: string = parsed?.compilerOptions?.baseUrl ?? '.';
      if (!paths || typeof paths !== 'object') continue;
      const aliases: PathAlias[] = [];
      for (const [key, value] of Object.entries(paths)) {
        if (!Array.isArray(value)) continue;
        const prefix = key.replace(/\*$/, '');
        const targets = (value as string[]).map((t) => {
          const tStripped = t.replace(/\*$/, '');
          const joined = path.posix.normalize(
            path.posix.join(baseUrl.replace(/\\/g, '/'), tStripped.replace(/\\/g, '/'))
          );
          return joined.replace(/^\.\//, '');
        });
        aliases.push({ prefix, targets });
      }
      return aliases;
    } catch {
      // fall through to next candidate
    }
  }
  return [];
}

export function resolveDepToFile(
  db: DB,
  projectId: number,
  importPath: string,
  sourceFilePath: string,
  aliases: PathAlias[],
): { id: number } | undefined {
  const normalizedImport = importPath.replace(/\\/g, '/');
  const basePaths: string[] = [];

  if (normalizedImport.startsWith('.')) {
    const sourceDir = sourceFilePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    const parts = normalizedImport.split('/');
    const dirParts = sourceDir ? sourceDir.split('/') : [];
    const resolved: string[] = [...dirParts];
    for (const part of parts) {
      if (part === '..') resolved.pop();
      else if (part !== '.' && part !== '') resolved.push(part);
    }
    basePaths.push(resolved.join('/'));
  } else {
    for (const alias of aliases) {
      if (alias.prefix === '' || normalizedImport.startsWith(alias.prefix)) {
        const tail = alias.prefix === '' ? normalizedImport : normalizedImport.slice(alias.prefix.length);
        for (const target of alias.targets) {
          const joined = `${target.replace(/\/$/, '')}/${tail}`.replace(/\/+/g, '/');
          basePaths.push(joined);
        }
      }
    }
    if (basePaths.length === 0) return undefined;
  }

  const stmt = db.prepare('SELECT id FROM files WHERE project_id = ? AND path = ?');

  for (const raw of basePaths) {
    const basePath = raw.replace(/\.(js|mjs|cjs)$/, '');
    const candidates = [
      basePath + '.ts',
      basePath + '.tsx',
      basePath + '.mts',
      basePath + '.cts',
      basePath + '.js',
      basePath + '.jsx',
      basePath,
      basePath + '/index.ts',
      basePath + '/index.tsx',
      basePath + '/index.js',
      basePath + '/index.jsx',
    ];
    for (const candidate of candidates) {
      const file = stmt.get(projectId, candidate) as { id: number } | undefined;
      if (file) return file;
    }
  }
  return undefined;
}
