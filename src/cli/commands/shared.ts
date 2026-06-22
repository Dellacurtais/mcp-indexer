/**
 * Shared helpers for the `index` and `serve` commands: safe root resolution,
 * project/context setup, and the hardened incremental watcher.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from '@ctx/shared/utils/config.js';
import { CodeIndexDB } from '@ctx/store/db.js';
import {
  createAndSeedProviderStore,
  createSearchBundle,
} from '@ctx/indexer/bootstrap/index.js';
import { createReranker } from '@ctx/indexer/search/reranker.js';
import { runStructuralIndex } from '@ctx/indexer/indexer/structural.js';
import { runEmbedBackfill } from '@ctx/indexer/embed-backfill.js';
import { FileWatcherService } from '@ctx/services/services/watcher.js';
import { seedLocalDefaults } from '../../bootstrap/seed.js';
import type { ToolContext } from '../../mcp/context.js';

export function log(msg: string): void {
  // stderr only — stdout is the MCP channel in serve mode.
  process.stderr.write(`[code-context] ${msg}\n`);
}

/**
 * Strip absolute paths / scope / product tokens from a tool error before it is
 * returned to the client (defense-in-depth for the anonymization goal). Full
 * detail is logged to stderr.
 */
export function scrubError(msg: string): string {
  return msg
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, '<path>')
    .replace(/(?:\/[\w.@-]+){2,}/g, '<path>')
    .replace(/@(?:mcp|ctx)\/[\w/-]+/gi, '<module>')
    .replace(/mcp-code-indexer|codestudio/gi, 'code-context');
}

/** Resolve and validate a project root — refuse home / drive-root / missing. */
export function resolveRoot(rootArg: string): string {
  const root = path.resolve(rootArg);
  const home = path.resolve(os.homedir());
  const driveRoot = path.resolve(path.parse(root).root || '/');
  if (root === home) {
    throw new Error(`refusing to use your home directory (${root}) — pass an explicit project path`);
  }
  if (root === driveRoot) {
    throw new Error(`refusing to use a filesystem root (${root}) — pass an explicit project path`);
  }
  if (!fs.existsSync(root)) throw new Error(`path does not exist: ${root}`);
  if (!fs.statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);
  return root;
}

export interface OpenedProject {
  db: CodeIndexDB;
  project: { id: number; name: string };
  ctx: ToolContext;
  embeddingsOn: boolean;
}

/** Open the DB, register the project, seed offline defaults, build the search bundle. */
export function openProject(root: string, opts: { noEmbeddings?: boolean }): OpenedProject {
  const config = loadConfig();
  const db = new CodeIndexDB(config.dbPath);
  const project = db.getProjectByPath(root) ?? db.createProject(path.basename(root), root);
  const providerStore = createAndSeedProviderStore(config.dbPath);
  const embeddingsOn = !opts.noEmbeddings;
  if (embeddingsOn) seedLocalDefaults(db);
  const { embeddingService, vectorStore, hybridSearch } = createSearchBundle(
    db,
    providerStore,
    createReranker(providerStore),
  );
  const ctx: ToolContext = { config, db, providerStore, embeddingService, vectorStore, hybridSearch };
  return { db, project: { id: project.id, name: project.name }, ctx, embeddingsOn };
}

/**
 * Incremental watcher: on a debounced batch of changes, re-run the structural
 * pass (only changed files are reprocessed via semantic_hash) and backfill
 * embeddings for the deltas. The watcher itself is hardened in watcher.ts so an
 * unwatchable path never crashes the process.
 */
export function startIncrementalWatch(opened: OpenedProject, root: string): FileWatcherService {
  const { db, project, ctx, embeddingsOn } = opened;
  const watcher = new FileWatcherService();
  watcher.startWatching(
    project.id,
    { rootPath: root, debounce: 1500 },
    {
      onFileChanged: async () => {
        try {
          await runStructuralIndex(db, project.id, {});
          if (embeddingsOn) {
            await runEmbedBackfill(db, project, root, ctx.embeddingService, ctx.vectorStore);
          }
        } catch (e) {
          log(`reindex error: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
  );
  return watcher;
}
