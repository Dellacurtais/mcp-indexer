/**
 * `serve [root]` — the MCP server an editor (VS Code / IntelliJ Copilot) spawns.
 *
 * Opens the EXISTING index and serves the curated, shaped retrieval tools
 * directly over stdio — no broker/daemon/spawn, so the handshake is instant. It
 * does NOT index on connect (run `index`, or call the `reindex` tool from chat).
 *
 * Project resolution, in order:
 *   1. explicit `<root>` argument, if given;
 *   2. the client's MCP **roots** (workspace folders) — VS Code provides these
 *      automatically, so no path is needed there; JetBrains too if it exposes
 *      roots;
 *   3. otherwise: a clear error telling the user to pass an explicit path.
 * (Never falls back to cwd — under JetBrains the cwd is the home dir.)
 */
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { FileWatcherService } from '@ctx/services/services/watcher.js';
import { disposeIndexerProcessResources } from '@ctx/indexer/bootstrap/dispose.js';
import { buildToolRegistry } from '../../mcp/tools/index.js';
import { shapeRegistry, resolveAllowlist } from '../../mcp/shaping.js';
import { disposeAllSessions } from '../../mcp/tools/exec.js';
import { SERVER_INSTRUCTIONS } from '../../mcp/instructions.js';
import type { McpTool } from '../../mcp/tool.js';
import type { ToolContext } from '../../mcp/context.js';
import {
  resolveRoot,
  openProject,
  startIncrementalWatch,
  scrubError,
  log,
  type OpenedProject,
} from './shared.js';

const VERSION = '0.1.0';
function serverName(): string {
  return process.env.MCP_SERVER_NAME ?? 'code-context';
}

export interface ServeOpts {
  noEmbeddings?: boolean;
  watch?: boolean;
}

/** Ask the client for its workspace roots; return the first as a path, or null. */
async function rootFromClientRoots(server: Server): Promise<string | null> {
  try {
    const res = await server.listRoots();
    const uri = res.roots?.[0]?.uri;
    if (!uri) return null;
    return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
  } catch {
    return null; // client doesn't expose roots
  }
}

export async function runServe(rootArg: string | undefined, opts: ServeOpts): Promise<void> {
  const base = buildToolRegistry();
  const allowed = new Set(resolveAllowlist());
  // Static tool defs (allowlisted) — returned for ListTools without needing the
  // project resolved yet, so the handshake/tool-list never blocks.
  const staticDefs = [...base.values()]
    .filter((t) => allowed.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

  const server = new Server(
    { name: serverName(), version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  let opened: OpenedProject | null = null;
  let watcher: FileWatcherService | null = null;
  let readyP: Promise<{ registry: Map<string, McpTool>; ctx: ToolContext }> | null = null;

  const resolveAndOpen = async (): Promise<{ registry: Map<string, McpTool>; ctx: ToolContext }> => {
    const rawRoot =
      rootArg && rootArg.trim().length > 0 ? rootArg : await rootFromClientRoots(server);
    if (!rawRoot) {
      throw new Error(
        'no workspace detected. Pass an explicit path in the MCP config ' +
          '(…/dist/cli/index.js serve <project-root>) — your editor did not provide a workspace root.',
      );
    }
    const root = resolveRoot(rawRoot);
    opened = openProject(root, opts);
    const registry = shapeRegistry(base, { projectName: opened.project.name });
    if (opts.watch !== false) watcher = startIncrementalWatch(opened, root);
    const fileCount = opened.db.getStats(opened.project.id).file_count ?? 0;
    log(
      `serving ${opened.project.name} (${root}) — ${registry.size} tools, ${fileCount} files indexed` +
        (fileCount === 0 ? ` — ask me to "reindex" (or run: code-context index ${root})` : ''),
    );
    return { registry, ctx: opened.ctx };
  };
  const ready = (): Promise<{ registry: Map<string, McpTool>; ctx: ToolContext }> => {
    if (!readyP) {
      readyP = resolveAndOpen().catch((e) => {
        readyP = null; // allow retry on the next call
        throw e;
      });
    }
    return readyP;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: staticDefs }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    let r: { registry: Map<string, McpTool>; ctx: ToolContext };
    try {
      r = await ready();
    } catch (e) {
      return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
    const tool = r.registry.get(req.params.name);
    if (!tool) {
      return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
    }
    try {
      const out = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>, r.ctx);
      return { content: [{ type: 'text', text: typeof out === 'string' ? out : String(out) }] };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log(`tool "${req.params.name}" error: ${detail}`);
      return { content: [{ type: 'text', text: scrubError(detail) }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport()); // instant handshake

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    const watchdog = setTimeout(() => process.exit(1), 5000);
    watchdog.unref();
    try {
      disposeAllSessions(); // kill any opt-in exec sessions
    } catch {
      /* ignore */
    }
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
      opened?.db.close();
    } catch {
      /* ignore */
    }
    clearTimeout(watchdog);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
