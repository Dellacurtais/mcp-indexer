#!/usr/bin/env node
import { Command } from 'commander';
import { runIndex } from './commands/index-cmd.js';
import { runServe } from './commands/serve.js';
import { runStatus, runSearch, runProjects } from './commands/query.js';

const program = new Command();
program
  .name(process.env.MCP_SERVER_NAME ?? 'code-context')
  .description('Index a project and serve dense code-retrieval tools over MCP')
  .version('0.1.0');

program
  .command('index')
  .description('Build/refresh a project index (structural + local embeddings). Run this first.')
  .argument('<root>', 'project root to index')
  .option('--no-embeddings', 'structural + FTS only (skip local embeddings)')
  .option('--watch', 'keep watching for changes after indexing (incremental)')
  .action(async (root: string, opts: { embeddings?: boolean; watch?: boolean }) => {
    await runIndex(root, { noEmbeddings: opts.embeddings === false, watch: !!opts.watch });
  });

program
  .command('serve')
  .description('Serve dense retrieval tools over MCP for an editor (reads the existing index).')
  .argument(
    '[root]',
    'project root to serve; omit to auto-detect from the editor\'s MCP workspace roots (VS Code)',
  )
  .option('--no-embeddings', 'do not seed local embeddings (FTS-only retrieval)')
  .option('--no-watch', 'do not run the incremental file watcher')
  .action(async (root: string | undefined, opts: { embeddings?: boolean; watch?: boolean }) => {
    await runServe(root, { noEmbeddings: opts.embeddings === false, watch: opts.watch !== false });
  });

program
  .command('status')
  .description('Show index status (files, symbols, vector coverage) for a project.')
  .argument('[root]', 'project root (default: current directory)')
  .action((root: string | undefined) => {
    runStatus(root);
  });

program
  .command('search')
  .description('Query the index from the terminal and print ranked hits.')
  .argument('<query>', 'search query (natural language or identifier)')
  .argument('[root]', 'project root (default: current directory)')
  .option('--mode <mode>', 'auto | fts | vector | hybrid', 'auto')
  .option('--type <type>', 'files | symbols | all', 'all')
  .option('--limit <n>', 'max results', '15')
  .action(async (query: string, root: string | undefined, opts: { mode?: string; type?: string; limit?: string }) => {
    await runSearch(query, root, opts);
  });

program
  .command('projects')
  .description('List all indexed projects.')
  .action(() => {
    runProjects();
  });

// Deprecated alias for the old broker entry — now serve-only.
program
  .command('context', { hidden: true })
  .argument('[root]')
  .option('--no-embeddings')
  .option('--no-watch')
  .action(async (root: string | undefined, opts: { embeddings?: boolean; watch?: boolean }) => {
    await runServe(root, { noEmbeddings: opts.embeddings === false, watch: opts.watch !== false });
  });

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`[code-context] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
