/**
 * `index <root>` — build (or refresh) the index for a project: structural
 * (tree-sitter + FTS) plus local ONNX embeddings. Foreground, with progress.
 * Re-runnable (incremental via content/semantic hashes). With `--watch` it stays
 * alive and keeps the index fresh incrementally.
 */
import { runStructuralIndex } from '@ctx/indexer/indexer/structural.js';
import { runEmbedBackfill } from '@ctx/indexer/embed-backfill.js';
import { disposeIndexerProcessResources } from '@ctx/indexer/bootstrap/dispose.js';
import { resolveRoot, openProject, startIncrementalWatch, log } from './shared.js';

export interface IndexOpts {
  noEmbeddings?: boolean;
  watch?: boolean;
}

export async function runIndex(rootArg: string, opts: IndexOpts): Promise<void> {
  const root = resolveRoot(rootArg);
  const opened = openProject(root, opts);

  log(`indexing ${opened.project.name} (${root}) …`);
  const res = await runStructuralIndex(opened.db, opened.project.id, {
    onProgress: (p) =>
      process.stderr.write(`\r  ${p.phase} ${p.current ?? ''}/${p.total ?? ''}            `),
  });
  process.stderr.write('\n');
  log(`indexed ${res.indexed}/${res.totalFiles} files (${res.errorCount} errors, ${res.durationMs}ms)`);

  if (opened.embeddingsOn) {
    log('embedding (first run downloads the local ONNX model ~100MB) …');
    const eb = await runEmbedBackfill(
      opened.db,
      opened.project,
      root,
      opened.ctx.embeddingService,
      opened.ctx.vectorStore,
      {
        onProgress: (done, total) => process.stderr.write(`\r  embedded ${done}/${total}            `),
      },
    );
    process.stderr.write('\n');
    log(`embedded ${eb.embedded}/${eb.candidates} candidates (${eb.batches} batches)`);
  }

  if (opts.watch) {
    startIncrementalWatch(opened, root);
    log('watching for changes (Ctrl+C to stop) …');
    const shutdown = async (): Promise<void> => {
      try {
        await disposeIndexerProcessResources();
      } catch {
        /* ignore */
      }
      opened.db.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise<never>(() => {});
  } else {
    try {
      await disposeIndexerProcessResources();
    } catch {
      /* ignore */
    }
    opened.db.close();
  }
}
