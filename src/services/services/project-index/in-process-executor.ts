import type { CodeIndexDB } from '@ctx/store/db.js';
import { runStructuralIndex } from '@ctx/indexer/indexer/structural.js';
import { indexFilesStructural, removeFilesStructural } from '@ctx/indexer/indexer/structural-incremental.js';
import type { StructuralExecutor } from './types.js';

export interface InProcessExecutorConfig {
  ignorePatterns?: string[];
  maxFileSizeKB?: number;
  concurrency?: number;
}

/**
 * Fallback executor running the structural pipeline on the current thread.
 * Tree-sitter still offloads to the index-job worker pool when enabled
 * (tree-sitter-dispatch default), but the scanner + SQLite writes stay
 * here — acceptable for small projects and as the no-worker-build safety
 * net; the indexer worker client replaces this at app boot.
 */
export function createInProcessStructuralExecutor(
  db: CodeIndexDB,
  config: InProcessExecutorConfig = {},
): StructuralExecutor {
  return {
    async runStructuralIndex(projectId, opts) {
      const r = await runStructuralIndex(db, projectId, {
        ignorePatterns: config.ignorePatterns,
        maxFileSizeKB: config.maxFileSizeKB,
        concurrency: config.concurrency,
        maxFiles: opts.maxFiles,
        allowEmptyWipe: opts.allowEmptyWipe,
        onProgress: opts.onProgress,
      });
      return {
        totalFiles: r.totalFiles, indexed: r.indexed, removed: r.removed,
        skipped: r.skipped, errorCount: r.errorCount, durationMs: r.durationMs,
        aborted: r.aborted,
      };
    },
    async indexFiles(projectId, relPaths) {
      return indexFilesStructural(db, projectId, relPaths, {
        ignorePatterns: config.ignorePatterns,
        maxFileSizeKB: config.maxFileSizeKB,
      });
    },
    async removeFiles(projectId, relPaths) {
      return removeFilesStructural(db, projectId, relPaths);
    },
  };
}
