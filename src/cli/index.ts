#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runIndex } from './commands/index-cmd.js';
import { runServe } from './commands/serve.js';
import { runEnrich } from './commands/enrich.js';
import { runInstall } from './commands/install.js';
import { runUi } from './commands/ui.js';
import { runLogin } from './commands/login.js';
import { runStatus, runSearch, runProjects } from './commands/query.js';

const program = new Command();
program
  .name(process.env.MCP_SERVER_NAME ?? 'code-context')
  .description('Index a project and serve dense code-retrieval tools over MCP');

// `-v` / `--version`: print version + build provenance so you can confirm the
// running build matches your working tree in dev (git SHA + dirty + build time).
program.option('-v, --version', 'print version, build info (git SHA + build time) and dist path');

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
  .option('--kind <kind>', 'analysis backend: bedrock | copilot | mock (default: $CODE_CONTEXT_ANALYSIS)')
  .option('--model <id>', 'model id (Bedrock id, or a Copilot model like gpt-4o-mini)')
  .option('--inference', 'prepend the region inference-profile prefix (us./eu./apac.) to the model id')
  .option('--min-lines <n>', 'skip files shorter than N lines (default 8)')
  .option('--mock', 'alias for --kind mock (offline preview without AWS / cost)')
  .option('--dry-run', 'list the files that would be enriched and exit (no cost)')
  .option('--synthesize', 'also print a project architecture summary built from the file summaries')
  .action(
    async (
      root: string | undefined,
      opts: {
        limit?: string;
        budget?: string;
        kind?: string;
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
        kind: opts.kind ?? (opts.mock ? 'mock' : undefined),
        dryRun: !!opts.dryRun,
        synthesize: !!opts.synthesize,
      });
    },
  );

program
  .command('install')
  .description('Scaffold the Copilot custom-instructions file (.github/copilot-instructions.md) so the agent uses code-context.')
  .argument('[root]', 'target repo (default: current directory)')
  .option('--force', 'overwrite existing instruction files')
  .option('--agents', 'also write a root AGENTS.md (cross-agent standard)')
  .option('--mcp', 'also write .vscode/mcp.json wiring this build (VS Code)')
  .option('--index', 'also build the index now (so the agent can use it immediately)')
  .action(async (root: string | undefined, opts: { force?: boolean; agents?: boolean; mcp?: boolean; index?: boolean }) => {
    await runInstall(root, { force: !!opts.force, agents: !!opts.agents, mcp: !!opts.mcp, index: !!opts.index });
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

program
  .command('ui')
  .description('Open the local configuration dashboard in your browser (projects, AWS/Bedrock setup, search).')
  .option('--no-open', 'do not open the browser automatically')
  .option('--port <n>', 'port to listen on (default 7333)')
  .action(async (opts: { open?: boolean; port?: string }) => {
    await runUi({ open: opts.open !== false, port: opts.port ? Number(opts.port) : undefined });
  });

program
  .command('login')
  .description('Connect a provider via OAuth so enrich / explore can use it (no per-token cost on your Copilot plan).')
  .argument('<provider>', 'provider to connect — currently: copilot')
  .action(async (provider: string) => {
    await runLogin(provider);
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

function printVersion(): void {
  const selfPath = fileURLToPath(import.meta.url);
  const pkgRoot = join(dirname(selfPath), '..', '..'); // dist/cli -> repo/package root
  let version = '0.1.0';
  try {
    version = (JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version?: string }).version ?? version;
  } catch {
    /* keep default */
  }
  let built = '';
  try {
    built = statSync(selfPath).mtime.toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    /* ignore */
  }
  let git = '';
  try {
    const run = (args: string[]): string =>
      execFileSync('git', ['-C', pkgRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const sha = run(['rev-parse', '--short', 'HEAD']);
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    let dirty = '';
    try {
      dirty = run(['status', '--porcelain']) ? '-dirty' : '';
    } catch {
      /* ignore */
    }
    git = ` (${branch} ${sha}${dirty})`;
  } catch {
    /* not a git checkout (e.g. a published install) */
  }
  process.stdout.write(`code-context ${version}${git}\n`);
  if (built) process.stdout.write(`  built: ${built}\n`);
  process.stdout.write(`  dist:  ${selfPath}\n`);
}

// Handle -v / --version (and legacy -V) before commander parses subcommands.
const versionFlags = new Set(['-v', '-V', '--version']);
if (process.argv.slice(2).some((a) => versionFlags.has(a))) {
  printVersion();
  process.exit(0);
}

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`[code-context] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
