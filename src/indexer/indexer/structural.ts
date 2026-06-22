/**
 * Structural-only project indexing — IntelliJ's "dumb mode" pass.
 *
 * scanner (stat-first, hash-incremental) → tree-sitter → symbols/deps/refs +
 * content FTS. No LLM, no embeddings, no cost tracking, no provider — which
 * is exactly what lets this run automatically on project open (freemium/BYOK:
 * zero spend) and inside the dedicated indexer worker (no singletons to wire).
 *
 * Deliberately NOT an IndexAgent mode: the agent's constructor demands
 * provider/embedding/vector deps this path must never touch. The full
 * pipeline reuses this run's work via `files.semantic_hash` staleness (see
 * process-file-structural.ts for the invariants).
 */
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type { CodeIndexDB } from '@ctx/store/db.js';
import { FileScanner } from '@ctx/indexer/indexer/scanner.js';
import { buildTreeSitterDispatch } from '@ctx/indexer/indexer/tree-sitter-dispatch.js';
import { withConcurrency } from './indexer/enrich-references.js';
import { processFileStructural } from './indexer/process-file-structural.js';
import { removeFilesStructural } from './structural-incremental.js';

const STRUCTURAL_YIELD_EVERY = 50;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface StructuralProgress {
  current: number;
  total: number;
  currentFile: string;
  /** 'scanning' (silent tree walk, total may be 0) vs 'indexing' (per-file pass). */
  phase?: 'scanning' | 'indexing';
}

export interface StructuralIndexOptions {
  onProgress?: (p: StructuralProgress) => void;
  /** Cooperative abort — remaining files are skipped, run finishes as failed. */
  signal?: AbortSignal;
  /** Candidate-count gate: above this the run bails with `aborted: 'too_large'` (project untouched). */
  maxFiles?: number;
  /**
   * Escape hatch for the empty-scan anti-wipe guard (manual reindex only):
   * a scan that finds ZERO files but would remove existing rows is treated
   * as a misconfiguration (wrong root_path, aggressive ignore, unmounted
   * drive) and aborted — wiping a good index is far worse than staleness.
   */
  allowEmptyWipe?: boolean;
  concurrency?: number;
  ignorePatterns?: string[];
  maxFileSizeKB?: number;
}

export interface StructuralIndexResult {
  runId?: number;
  totalFiles: number;
  indexed: number;
  removed: number;
  skipped: number;
  errorCount: number;
  durationMs: number;
  aborted?: 'too_large' | 'signal' | 'empty_scan';
}

export async function runStructuralIndex(
  db: CodeIndexDB,
  projectId: number,
  opts: StructuralIndexOptions = {},
): Promise<StructuralIndexResult> {
  const startTime = Date.now();
  const project = db.getProject(projectId);
  if (!project) throw new Error(`project ${projectId} not found`);

  // Tiered-hybrid split (plan §8): lazily migrate this project's INDEX tables
  // into its own DB before indexing. No-op unless the split flags are on and the
  // project is still 'pending'. Fail-open: a split error never blocks indexing.
  try {
    db.ensureProjectSplit(projectId);
  } catch (e) {
    console.warn(`[structural] project-db split skipped for ${projectId}:`, (e as Error).message);
  }

  const scanner = new FileScanner(project.root_path, opts.ignorePatterns ?? [], opts.maxFileSizeKB ?? 200);
  const scan = await scanner.scan(db, projectId, {
    maxFiles: opts.maxFiles,
    // Keep the "Scanning…" chip alive during the walk (total unknown → 0).
    onScanProgress: (scanned, total) =>
      opts.onProgress?.({ phase: 'scanning', current: scanned, total, currentFile: '' }),
  });
  const totalFiles = scan.totalFiles ?? scan.toIndex.length + scan.unchanged.length;

  if (scan.aborted === 'too_large' || (opts.maxFiles && totalFiles > opts.maxFiles)) {
    return {
      totalFiles, indexed: 0, removed: 0, skipped: scan.unchanged.length,
      errorCount: 0, durationMs: Date.now() - startTime, aborted: 'too_large',
    };
  }

  // Anti-wipe guard: a scan that sees ZERO files while the index has rows is
  // almost always a broken root (renamed/unmounted path, ignore file that
  // excludes everything, getByPath mismatch) — removing `toRemove` here would
  // erase the whole index. Bail with a diagnosable marker instead.
  if (totalFiles === 0 && scan.toRemove.length > 0 && !opts.allowEmptyWipe) {
    console.error(
      `[structural] scan found 0 files at ${project.root_path} but the index has ${scan.toRemove.length} — ` +
      `refusing to wipe (ignored by scanner filters: ${scan.stats?.ignored ?? '?'}). ` +
      `Check project root / .gitignore / .mcpindexignore; manual reindex overrides.`,
    );
    return {
      totalFiles: 0, indexed: 0, removed: 0, skipped: 0,
      errorCount: 0, durationMs: Date.now() - startTime, aborted: 'empty_scan',
    };
  }

  const { removed } = removeFilesStructural(db, projectId, scan.toRemove);
  const runId = db.startRun(projectId, 'tree-sitter', undefined, 'structural');

  const treeSitter = buildTreeSitterDispatch();
  let indexed = 0;
  let errorCount = 0;
  let aborted: StructuralIndexResult['aborted'];

  // Progress must be MONOTONIC. `withConcurrency` runs files out of order, so
  // the enqueue index (idx) is not the completion order — reporting `idx + 1`
  // made the bar jump forward and backward under concurrency ≥ 2. Count files
  // as they actually finish instead. (`++completed` is a single synchronous op
  // after each file's awaits resolve, so the single-threaded event loop makes
  // it race-free.) Generalization (Option B): move this counter into
  // `withConcurrency` so the embeddings/full-pipeline callers get it for free.
  let completed = 0;
  try {
    await withConcurrency(scan.toIndex, async (file) => {
      if (opts.signal?.aborted) { aborted = 'signal'; return; }
      try {
        await processFileStructural(db, projectId, file, treeSitter);
        indexed++;
      } catch (err) {
        errorCount++;
        console.error(`[structural] Error processing ${file.relativePath}:`, err);
      }
      const current = ++completed;
      opts.onProgress?.({ phase: 'indexing', current, total: scan.toIndex.length, currentFile: file.relativePath });
      if (current % STRUCTURAL_YIELD_EVERY === 0) await yieldToEventLoop();
    }, opts.concurrency ?? 5);

    try {
      const sweep = sweepContentCoverage(db, projectId, project.root_path);
      if (sweep.added > 0) console.error(`[structural] Content coverage sweep: ${sweep.added} file(s) backfilled`);
    } catch (err) {
      errorCount++;
      console.error('[structural] Content coverage sweep failed:', err);
    }
  } finally {
    treeSitter.dispose();
  }

  const status = aborted || errorCount > scan.toIndex.length / 2
    ? 'failed'
    : errorCount > 0 ? 'completed_with_errors' : 'completed';

  // Counters always reflect reality; the READY stamp only lands when the run
  // actually succeeded over a non-empty project — a failed/empty run must
  // never flip the status chip to "Symbols ready". `fresh` bypasses the stats
  // read cache so the PERSISTED counts are never a stale cached value.
  const stats = db.getStats(projectId, { fresh: true });
  db.updateProject(projectId, {
    file_count: stats.file_count,
    symbol_count: stats.symbol_count,
    ...(status !== 'failed' && indexed + scan.unchanged.length > 0
      ? { structural_indexed_at: new Date().toISOString() }
      : {}),
    // last_indexed untouched — it keeps meaning "semantic index".
  });
  db.finishRun(runId, {
    status,
    totalFiles,
    indexedFiles: indexed,
    skippedFiles: scan.unchanged.length,
    errorCount,
    inputTokens: 0, outputTokens: 0, embeddingTokens: 0, estimatedCostUsd: 0,
  }, projectId);

  return {
    runId, totalFiles, indexed, removed, skipped: scan.unchanged.length,
    errorCount, durationMs: Date.now() - startTime, aborted,
  };
}

/**
 * Backfill `file_contents_fts` for rows without an entry — covers the first
 * upgrade (vtab born empty under existing hashes, so the scanner skips every
 * file), post-corruption recovery (repair recreates empty) and individual
 * failed writes. Guard-rejected files (minified, oversized) are fetched once
 * and skipped — the loop advances through the FULL missing list, never
 * re-querying, so they can't spin it.
 */
export function sweepContentCoverage(
  db: CodeIndexDB,
  projectId: number,
  rootPath: string,
): { added: number; skipped: number } {
  const missing = db.missingContentFiles(projectId, 1_000_000);
  let added = 0;
  let skipped = 0;
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200);
    db.indexTransaction(projectId, () => {
      for (const f of chunk) {
        try {
          const abs = join(rootPath, f.path);
          const st = statSync(abs, { throwIfNoEntry: false });
          if (!st?.isFile()) { skipped++; continue; }
          const content = readFileSync(abs, 'utf-8');
          if (db.upsertFileContent(f.id, content, st.size, projectId)) added++;
          else skipped++;
        } catch {
          skipped++;
        }
      }
    });
  }
  return { added, skipped };
}
