/**
 * `context <root>` — the broker entrypoint.
 *
 *   --daemon : run the long-running process that indexes <root>, watches it for
 *              changes, and serves the shaped tool registry over a loopback
 *              JSON API (records a lockfile under <root>/.mcp-context).
 *   (default): run the per-editor stdio MCP shim — ensure a daemon is up, then
 *              proxy MCP ListTools/CallTool to it.
 */
import path from 'node:path';
import { loadConfig } from '@ctx/shared/utils/config.js';
import { CodeIndexDB } from '@ctx/store/db.js';
import {
  createAndSeedProviderStore,
  createSearchBundle,
} from '@ctx/indexer/bootstrap/index.js';
import { createReranker } from '@ctx/indexer/search/reranker.js';
import { runStructuralIndex } from '@ctx/indexer/indexer/structural.js';
import { runEmbedBackfill } from '@ctx/indexer/embed-backfill.js';
import { disposeIndexerProcessResources } from '@ctx/indexer/bootstrap/dispose.js';
import { FileWatcherService } from '@ctx/services/services/watcher.js';
import { seedLocalDefaults } from '../../bootstrap/seed.js';
import { buildToolRegistry } from '../../mcp/tools/index.js';
import { shapeRegistry } from '../../mcp/shaping.js';
import { startDaemonHttp } from '../../mcp/daemon-server.js';
import { runStdioShim } from '../../mcp/shim.js';
import type { ToolContext } from '../../mcp/context.js';
import { ensureDaemon, writeLock, removeLock, liveDaemon } from '../daemon-registry.js';

const VERSION = '0.1.0';

function serverName(): string {
  return process.env.MCP_SERVER_NAME ?? 'code-context';
}

function log(msg: string): void {
  // stderr only — stdout is reserved for the MCP channel in shim mode.
  process.stderr.write(`[code-context] ${msg}\n`);
}

export interface ContextCommandOpts {
  daemon?: boolean;
  noEmbeddings?: boolean;
}

export async function runContextCommand(
  rootArg: string | undefined,
  opts: ContextCommandOpts,
  cliPath: string,
): Promise<void> {
  // Default to the current working directory when no path is given — lets a
  // single editor MCP entry (with no hardcoded path) target whatever project the
  // editor launched the server in.
  const root = path.resolve(rootArg && rootArg.length > 0 ? rootArg : process.cwd());
  if (opts.daemon) {
    await runDaemon(root, opts);
  } else {
    await runShim(root, opts, cliPath);
  }
}

async function runShim(root: string, opts: ContextCommandOpts, cliPath: string): Promise<void> {
  const { baseUrl } = await ensureDaemon(root, {
    cliPath,
    noEmbeddings: opts.noEmbeddings,
    env: {
      MCP_SERVER_NAME: serverName(),
      MCP_OUTPUT_CAP_LEVEL: process.env.MCP_OUTPUT_CAP_LEVEL,
    },
  });
  await runStdioShim({ baseUrl, serverName: serverName(), version: VERSION });
}

async function runDaemon(root: string, opts: ContextCommandOpts): Promise<void> {
  const config = loadConfig();
  const db = new CodeIndexDB(config.dbPath);
  const project = db.getProjectByPath(root) ?? db.createProject(path.basename(root), root);

  const providerStore = createAndSeedProviderStore(config.dbPath);
  if (!opts.noEmbeddings) seedLocalDefaults(db);
  const { embeddingService, vectorStore, hybridSearch } = createSearchBundle(
    db,
    providerStore,
    createReranker(providerStore),
  );
  const ctx: ToolContext = { config, db, providerStore, embeddingService, vectorStore, hybridSearch };
  const embeddingsOn = !opts.noEmbeddings;

  // Defense-in-depth against a double cold-start (ensureDaemon's spawn lock is
  // the primary guard): if a healthy daemon already owns this root, don't serve
  // a second one — just exit and let the existing one keep serving.
  const already = await liveDaemon(root);
  if (already) {
    log(`a daemon is already serving ${project.name} on ${already.baseUrl} — exiting`);
    db.close();
    return;
  }

  // SERVE FIRST: open the HTTP server + write the lockfile BEFORE indexing, so the
  // shim becomes healthy immediately even on a large repo (the structural pass can
  // take a while). Search returns progressively richer results as indexing fills
  // the DB in the background; embeddings (which may download the ONNX model on
  // first run) upgrade it to semantic/hybrid afterwards.
  const registry = shapeRegistry(buildToolRegistry(), { projectName: project.name });
  const daemon = await startDaemonHttp(registry, ctx, {
    serverName: serverName(),
    project: project.name,
    root,
  });
  writeLock(root, {
    port: daemon.port,
    pid: process.pid,
    project: project.name,
    root,
    startedAt: new Date().toISOString(),
    serverName: serverName(),
  });
  log(`daemon on http://127.0.0.1:${daemon.port} — ${registry.size} tools (indexing in background)`);

  const embed = async (eager: boolean): Promise<void> => {
    if (!embeddingsOn) return;
    try {
      if (eager) log('embedding (first run downloads the local ONNX model ~100MB) …');
      const eb = await runEmbedBackfill(db, project, root, embeddingService, vectorStore);
      if (eb.candidates > 0) log(`embedded ${eb.embedded}/${eb.candidates} candidates (${eb.batches} batches)`);
    } catch (e) {
      log(`embedding skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Initial index runs in the background so it never blocks serving.
  void (async () => {
    try {
      log(`indexing ${project.name} (${root}) …`);
      const res = await runStructuralIndex(db, project.id, {});
      log(`indexed ${res.indexed}/${res.totalFiles} files (${res.errorCount} errors, ${res.durationMs}ms)`);
      await embed(true);
    } catch (e) {
      log(`initial index error: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  const watcher = new FileWatcherService();
  watcher.startWatching(
    project.id,
    { rootPath: root, debounce: 2000 },
    {
      onFileChanged: async () => {
        try {
          await runStructuralIndex(db, project.id, {});
          await embed(false); // incremental — only re-embeds changed candidates
        } catch (e) {
          log(`reindex error: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      // second signal = force exit (escape hatch if a step is wedged)
      process.exit(1);
    }
    shuttingDown = true;
    log('shutting down …');
    // Watchdog: never let a stuck close() (e.g. a keep-alive socket) hang forever.
    const watchdog = setTimeout(() => process.exit(1), 5000);
    watchdog.unref();
    try {
      await watcher.stopAll();
    } catch {
      /* ignore */
    }
    try {
      await daemon.close();
    } catch {
      /* ignore */
    }
    try {
      await disposeIndexerProcessResources();
    } catch {
      /* ignore */
    }
    removeLock(root);
    try {
      db.close();
    } catch {
      /* ignore */
    }
    clearTimeout(watchdog);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // keep the daemon alive
  await new Promise<never>(() => {});
}
