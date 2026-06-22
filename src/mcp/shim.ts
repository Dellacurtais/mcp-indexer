/**
 * Per-editor stdio MCP shim.
 *
 * The editor (VS Code / IntelliJ Copilot) spawns this over stdio. It speaks the
 * MCP wire protocol to the editor and forwards every ListTools / CallTool to the
 * daemon's loopback JSON API (daemon-server.ts). The daemon owns the warm index
 * and watcher; the shim is stateless and cheap, so multiple editors share one
 * daemon.
 *
 * IMPORTANT: the stdio transport is connected IMMEDIATELY (so the client's
 * `initialize` is answered at once), and the daemon is ensured LAZILY in the
 * background. Blocking the handshake on daemon startup would trip the client's
 * connect timeout on first run / large repos.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';

export interface ShimOptions {
  serverName: string;
  version: string;
  /** Resolve (spawn if needed) the daemon and return its loopback base URL. */
  ensure: () => Promise<{ baseUrl: string }>;
}

const LIST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;

export async function runStdioShim(opts: ShimOptions): Promise<void> {
  const server = new Server(
    { name: opts.serverName, version: opts.version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  // Memoized daemon-readiness. A failed attempt clears itself so the next
  // request retries rather than caching a dead daemon.
  let readyP: Promise<{ baseUrl: string }> | null = null;
  const ready = (): Promise<{ baseUrl: string }> => {
    if (!readyP) {
      readyP = opts.ensure().catch((e) => {
        readyP = null;
        throw e;
      });
    }
    return readyP;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const { baseUrl } = await ready();
      const r = await fetch(`${baseUrl}/mcp/tools`, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`daemon /mcp/tools ${r.status}`);
      const body = (await r.json()) as { tools: unknown[] };
      return { tools: body.tools };
    } catch (e) {
      // Don't fail the request (which can drop the connection) — report empty
      // and let the next listTools retry once the daemon is up.
      process.stderr.write(
        `[code-context] tools unavailable yet: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return { tools: [] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    let baseUrl: string;
    try {
      ({ baseUrl } = await ready());
    } catch (e) {
      return {
        content: [{ type: 'text', text: `code-context daemon unavailable: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
    try {
      const r = await fetch(`${baseUrl}/mcp/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: req.params.name, args: req.params.arguments ?? {} }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!r.ok) {
        return { content: [{ type: 'text', text: `daemon error ${r.status}` }], isError: true };
      }
      const body = (await r.json()) as { content?: string; error?: string; isError?: boolean };
      if (body.error) {
        return { content: [{ type: 'text', text: body.error }], isError: true };
      }
      return { content: [{ type: 'text', text: body.content ?? '' }] };
    } catch (e) {
      const msg = (e as { name?: string }).name === 'TimeoutError' ? 'daemon timed out' : 'daemon unreachable';
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  });

  // Answer `initialize` immediately, THEN warm the daemon in the background.
  await server.connect(new StdioServerTransport());
  void ready().catch(() => {
    /* surfaced to the client on the first ListTools/CallTool */
  });
}
