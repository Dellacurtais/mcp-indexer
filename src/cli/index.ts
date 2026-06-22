#!/usr/bin/env node
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { runContextCommand } from './commands/context.js';

const cliPath = fileURLToPath(import.meta.url);

const program = new Command();
program
  .name(process.env.MCP_SERVER_NAME ?? 'code-context')
  .description('Index a project and serve dense code-retrieval tools over MCP')
  .version('0.1.0');

program
  .command('context')
  .description('Broker: --daemon indexes+watches+serves; default is the stdio MCP shim for an editor')
  .argument('<root>', 'project root directory to index and serve')
  .option('--daemon', 'run the long-running index + watch + serve daemon')
  .option('--no-embeddings', 'structural + FTS only (skip seeding local ONNX embeddings)')
  .action(async (root: string, opts: { daemon?: boolean; embeddings?: boolean }) => {
    await runContextCommand(
      root,
      { daemon: opts.daemon, noEmbeddings: opts.embeddings === false },
      cliPath,
    );
  });

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`[code-context] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
