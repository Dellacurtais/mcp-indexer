#!/usr/bin/env node
import { Command } from 'commander';
import { runIndex } from './commands/index-cmd.js';
import { runServe } from './commands/serve.js';
import { runEnrich } from './commands/enrich.js';
import { runStatus, runSearch, runProjects } from './commands/query.js';

const program = new Command();
program
  .name(process.env.MCP_SERVER_NAME ?? 'code-context')
  .description('Index a project and serve dense code-retrieval tools over MCP')
  .version('0.1.0');

program
  .command('index')
  .description('Build/refresh a project index (structural + local embeddings). Run this first.')
  .argument('[root]', 'project root to index (default: current directory)')
  .option('--no-embeddings', 'structural + FTS only (skip local embeddings)')
  .option('--watch', 'keep watching for changes after indexing (incremental)')
  .action(async (root: string | undefined, opts: { embeddings?: boolean; watch?: boolean }) => {
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
  .command('enrich')
  .description('Optional LLM enrichment (AWS Bedrock): summarize + classify the most depended-on files. Opt-in, budgeted.')
  .argument('[root]', 'project root (default: current directory)')
  .option('--limit <n>', 'max files to enrich (default 100)')
  .option('--budget <usd>', 'max USD to spend (default $MCP_INDEX_BUDGET or 1.00)')
  .option('--model <id>', 'Bedrock model id (default amazon.titan-text-express-v1)')
  .option('--inference', 'prepend the region inference-profile prefix (us./eu./apac.) to the model id')
  .option('--min-lines <n>', 'skip files shorter than N lines (default 8)')
  .option('--mock', 'use the offline mock provider (preview the pipeline without AWS / cost)')
  .option('--dry-run', 'list the files that would be enriched and exit (no cost)')
  .option('--synthesize', 'also print a project architecture summary built from the file summaries')
  .action(
    async (
      root: string | undefined,
      opts: {
        limit?: string;
        budget?: string;
        model?: string;
        inference?: boolean;
        minLines?: string;
        mock?: boolean;
        dryRun?: boolean;
        synthesize?: boolean;
      },
    ) => {
      await runEnrich(root, {
        limit: opts.limit ? Number(opts.limit) : undefined,
        budget: opts.budget ? Number(opts.budget) : undefined,
        model: opts.model,
        inference: !!opts.inference,
        minLines: opts.minLines ? Number(opts.minLines) : undefined,
        kind: opts.mock ? 'mock' : undefined,
        dryRun: !!opts.dryRun,
        synthesize: !!opts.synthesize,
      });
    },
  );

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
  .option('--lang <list>', 'keep only these languages (comma-separated), e.g. typescript')
  .option('--exclude-lang <list>', 'drop these languages, e.g. css,scss,html')
  .action(
    async (
      query: string,
      root: string | undefined,
      opts: { mode?: string; type?: string; limit?: string; lang?: string; excludeLang?: string },
    ) => {
      await runSearch(query, root, opts);
    },
  );

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
