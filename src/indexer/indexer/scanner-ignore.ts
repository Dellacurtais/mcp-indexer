/**
 * Scanner ignore rules: binary extensions, default patterns, .gitignore /
 * .mcpindexignore loading, and the hard-safe glob prune list. Extracted from
 * scanner.ts so the scan loop stays readable.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ignore from 'ignore';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac', '.ogg', '.webm',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.lib',
  '.pyc', '.pyo', '.class', '.jar', '.war',
  '.sqlite', '.db', '.sqlite3',
  '.lock',
]);

const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  '.mcp-indexer',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.cache',
  '.vscode',
  '.idea',
  '*.min.js',
  '*.min.css',
  '*.map',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
];

/**
 * Directories the glob walk prunes ENTIRELY (`**\/<dir>/**`). Only the
 * hard-safe set that the default patterns already discard 100% of — the
 * fine-grained rules (.gitignore, user patterns, binaries, mapper) still run
 * in the post-walk filter. Pruning here means the walker never descends into
 * node_modules at all, instead of listing it and filtering afterwards.
 */
export const GLOB_PRUNE_DIRS = [
  'node_modules', '.git', '.mcp-indexer', 'dist', 'build', '.next', '.nuxt',
  'coverage', '__pycache__', '.cache',
];

export interface ScannerIgnore {
  /** True when the relative path must be skipped (binary, ignored, hard-excluded). */
  ignores(relPath: string): boolean;
}

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filePath.slice(lastDot).toLowerCase();
}

/**
 * Build the composite ignore filter for a project root: defaults + caller
 * patterns + .gitignore + .mcpindexignore (project-specific rules).
 */
export function buildScannerIgnore(
  rootPath: string,
  extraPatterns: string[],
  isHardExcluded: (relPath: string) => boolean,
): ScannerIgnore {
  const ig = ignore();
  ig.add(DEFAULT_IGNORE_PATTERNS);
  ig.add(extraPatterns);

  const gitignorePath = join(rootPath, '.gitignore');
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, 'utf-8'));
  }

  const mcpIgnorePath = join(rootPath, '.mcpindexignore');
  if (existsSync(mcpIgnorePath)) {
    ig.add(readFileSync(mcpIgnorePath, 'utf-8'));
  }

  return {
    ignores(relPath: string): boolean {
      if (BINARY_EXTENSIONS.has(getExtension(relPath))) return true;
      if (ig.ignores(relPath)) return true;
      if (isHardExcluded(relPath)) return true;
      return false;
    },
  };
}
