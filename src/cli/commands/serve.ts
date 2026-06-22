/**
 * `serve <root>` — the MCP server an editor (VS Code / IntelliJ Copilot) spawns.
 *
 * Opens the EXISTING index for <root> and serves the curated, shaped retrieval
 * tools directly over stdio — no broker, no daemon, no spawn, so the handshake
 * is instant. It does NOT index on connect (run `code-context index <root>`
 * first); it does run a hardened incremental watcher so edits during the session
 * are reflected.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { disposeIndexerProcessResources } from '@ctx/indexer/bootstrap/dispose.js';
import { buildToolRegistry } from '../../mcp/tools/index.js';
import { shapeRegistry } from '../../mcp/shaping.js';
import { SERVER_INSTRUCTIONS } from '../../mcp/instructions.js';
import { resolveRoot, openProject, startIncrementalWatch, scrubError, log } from './shared.js';

const VERSION = '0.1.0';
function serverName(): string {
  return process.env.MCP_SERVER_NAME ?? 'code-context';
}

export interface ServeOpts {
  noEmbeddings?: boolean;
  watch?: boolean;
}

export async function runServe(rootArg: string, opts: ServeOpts): Promise<void> {
  const root = resolveRoot(rootArg);
  const opened = openProject(root, opts);
  const registry = shapeRegistry(buildToolRegistry(), { projectName: opened.project.name });

  const server = new Server(
    { name: serverName(), version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...registry.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = registry.get(req.params.name);
    if (!tool) {
      return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
    }
    try {
      const out = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>, opened.ctx);
      return { content: [{ type: 'text', text: typeof out === 'string' ? out : String(out) }] };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log(`tool "${req.params.name}" error: ${detail}`);
      return { content: [{ type: 'text', text: scrubError(detail) }], isError: true };
    }
  });

  // Connect first so `initialize`/`listTools` answer immediately.
  await server.connect(new StdioServerTransport());
  const fileCount = opened.db.getStats(opened.project.id).file_count ?? 0;
  log(
    `serving ${opened.project.name} (${root}) — ${registry.size} tools, ${fileCount} files indexed` +
      (fileCount === 0 ? ` — run "code-context index ${root}" to build the index` : ''),
  );

  const watcher = opts.watch === false ? null : startIncrementalWatch(opened, root);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    const watchdog = setTimeout(() => process.exit(1), 5000);
    watchdog.unref();
    try {
      await watcher?.stopAll();
    } catch {
      /* ignore */
    }
    try {
      await disposeIndexerProcessResources();
    } catch {
      /* ignore */
    }
    try {
      opened.db.close();
    } catch {
      /* ignore */
    }
    clearTimeout(watchdog);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // stdio transport keeps the process alive until the editor closes the pipe.
}
