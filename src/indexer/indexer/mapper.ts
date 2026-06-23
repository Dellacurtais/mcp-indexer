/**
 * Path-based file classifier. Decides whether a scanned file is worth
 * paying full LLM + embedding cost for, or can be downgraded / skipped
 * entirely.
 *
 * Today only the `excluded` branch is wired into the scanner — files
 * that cleanly fail the path/size heuristics never reach Tree-sitter or
 * the LLM. The other tiers are returned for future use (cost dashboards,
 * tier-aware embedding) but do not yet alter pipeline behavior. Keeping
 * the function pure makes it easy to test and to extend with content
 * heuristics or graph signals later without changing the scanner.
 *
 * Heuristics intentionally err on the side of *keeping* a file when
 * uncertain — false negatives cost a few extra tokens, false positives
 * silently drop code from the index.
 */

export type FileIndexTier = 'core' | 'support' | 'on_demand' | 'excluded';

export interface ClassificationResult {
  tier: FileIndexTier;
  reason: string;
}

/**
 * Files that match these patterns add no signal to the index — they are
 * lockfiles, build artefacts, vendored bundles, or huge generated blobs.
 * Each entry is matched as a literal substring or a glob-like suffix
 * check inside `classifyPath`. Keep them ordered roughly by frequency.
 */
const HARD_EXCLUDE_SUFFIXES = [
  '.tsbuildinfo',
  '.lock',
  '.lockb',
  '.min.js',
  '.min.css',
  '.min.mjs',
  '.bundle.js',
  '.chunk.js',
  '.map',
  '.snap',
  '.pyc',
  '.class',
  '.o',
  '.a',
];

const HARD_EXCLUDE_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'composer.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'go.sum',
  'mix.lock',
]);

const HARD_EXCLUDE_DIRS = [
  'node_modules/',
  '.git/',
  '.mcp-indexer/',
  'dist/',
  'build/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.parcel-cache/',
  '.cache/',
  'coverage/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.tox/',
  'target/',
  'vendor/',
  'venv/',
  '.venv/',
  '.idea/',
  '.vscode/',
  'storybook-static/',
  '.serverless/',
  // .NET / Angular / Gradle build output & cache (safe set — bin/ and packages/
  // are intentionally excluded since they can hold source in some projects).
  'obj/',
  '.vs/',
  '.angular/',
  '.gradle/',
];

/**
 * Files that still get indexed but rarely drive answers. The scanner
 * currently treats them like `support`; a future pass can route them
 * to FTS-only based on query intent.
 */
const ON_DEMAND_PATTERNS = [
  /(^|\/)__tests__\//,
  /(^|\/)__mocks__\//,
  /(^|\/)tests?\//,
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.stories\.[jt]sx?$/,
  /\.fixture\.[jt]sx?$/,
  /(^|\/)fixtures?\//,
  /(^|\/)e2e\//,
  /(^|\/)docs?\//,
  /(^|\/)examples?\//,
  /(^|\/)samples?\//,
  /\.md$/,
  /\.mdx$/,
  /(^|\/)migrations?\//,
];

/** Path fragments that flag a file as a likely-`core` entrypoint. */
const CORE_HINTS = [
  /\/(server|router|routes|api|controllers?|services?|models?|stores?|providers?|schemas?|use[-_]cases?)\//,
  /\/(index|main|app|server|client)\.[jt]sx?$/,
  /\/types?\.[jt]sx?$/,
];

/**
 * Classify a file path. The caller has already applied gitignore /
 * .mcpindexignore — this function adds the heuristics that those
 * configs typically don't cover (build outputs, vendored bundles,
 * generated files inferred from path).
 *
 * `sizeBytes` lets us drop pathological cases (>1 MB single file, no
 * symbols expected) before paying for tree-sitter. The default budget
 * elsewhere is 200 KB; oversized files are excluded outright here.
 */
export function classifyPath(
  relativePath: string,
  sizeBytes: number,
): ClassificationResult {
  const path = relativePath.replace(/\\/g, '/');
  const lower = path.toLowerCase();
  const basename = lower.split('/').pop() ?? lower;

  // 1. Hard excludes — directories that scanner-level ignores tend to miss
  // when the user's gitignore is permissive (e.g. monorepos with vendored
  // sub-packages that ship `dist/` checked in).
  for (const dir of HARD_EXCLUDE_DIRS) {
    if (lower.includes(`/${dir}`) || lower.startsWith(dir)) {
      return { tier: 'excluded', reason: `inside ${dir}` };
    }
  }

  if (HARD_EXCLUDE_BASENAMES.has(basename)) {
    return { tier: 'excluded', reason: `lockfile (${basename})` };
  }

  for (const suffix of HARD_EXCLUDE_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return { tier: 'excluded', reason: `extension ${suffix}` };
    }
  }

  // 2. Size guard — pathologically large source files almost always come
  // from generators or accidental commits of compiled output.
  if (sizeBytes > 1_000_000) {
    return { tier: 'excluded', reason: `oversized (${(sizeBytes / 1024).toFixed(0)} KB)` };
  }

  // 3. Vendor / generated heuristics inferred from path tokens.
  if (/\/(vendor|third[-_]party|generated|gen|__generated__)\//.test(lower)) {
    return { tier: 'excluded', reason: 'vendor/generated path' };
  }

  // 4. On-demand: tests, fixtures, docs — kept in FTS but not load-bearing
  // for typical "how does X work" questions.
  for (const pat of ON_DEMAND_PATTERNS) {
    if (pat.test(lower)) {
      return { tier: 'on_demand', reason: 'tests/docs/migrations' };
    }
  }

  // 5. Core: matches a known important location.
  for (const pat of CORE_HINTS) {
    if (pat.test(lower)) {
      return { tier: 'core', reason: 'matches entrypoint pattern' };
    }
  }

  // 6. Everything else is `support` — indexed normally but not promoted.
  return { tier: 'support', reason: 'default' };
}

/**
 * In-degree threshold above which a `support` file is promoted to
 * `core`. Heuristic: if more than ~3 other files import it, it's a
 * shared module worth pre-embedding regardless of its path.
 */
const CORE_PROMOTION_INDEGREE = 4;

/**
 * Adjust a tier using an external graph signal (in-degree from
 * `file_dependencies`). Only promotes — never demotes — so tests and
 * docs stay `on_demand` even when widely imported.
 */
export function applyGraphPromotion(
  tier: FileIndexTier,
  indegree: number | undefined,
): FileIndexTier {
  if (!indegree || indegree < CORE_PROMOTION_INDEGREE) return tier;
  if (tier === 'support') return 'core';
  return tier;
}

/**
 * Quick check used by the scanner to drop files before reading content.
 * Equivalent to `classifyPath(...).tier === 'excluded'` but skips the
 * full classification when only the boolean answer is needed.
 */
export function isHardExcluded(relativePath: string): boolean {
  const lower = relativePath.replace(/\\/g, '/').toLowerCase();
  const basename = lower.split('/').pop() ?? lower;

  if (HARD_EXCLUDE_BASENAMES.has(basename)) return true;
  for (const suffix of HARD_EXCLUDE_SUFFIXES) if (lower.endsWith(suffix)) return true;
  for (const dir of HARD_EXCLUDE_DIRS) {
    if (lower.includes(`/${dir}`) || lower.startsWith(dir)) return true;
  }
  if (/\/(vendor|third[-_]party|generated|gen|__generated__)\//.test(lower)) return true;
  return false;
}
