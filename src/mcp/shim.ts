/**
 * Per-editor stdio MCP shim.
 *
 * The editor (VS Code / IntelliJ Copilot) spawns this over stdio. It speaks the
 * MCP wire protocol to the editor and forwards every ListTools / CallTool to the
 * daemon's loopback JSON API (daemon-server.ts). The daemon owns the warm index
 * and watcher; the shim is stateless and cheap, so multiple editors share one
 * daemon.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export interface ShimOptions {
  baseUrl: string; // e.g. http://127.0.0.1:53111
  serverName: string;
  version: string;
}

export async function runStdioShim(opts: ShimOptions): Promise<void> {
  const server = new Server(
    { name: opts.serverName, version: opts.version },
    { capabilities: { tools: {} } },
  );

  // Timeouts so a wedged/slow daemon never hangs the editor's tool call forever.
  const LIST_TIMEOUT_MS = 10_000;
  const CALL_TIMEOUT_MS = 120_000;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const r = await fetch(`${opts.baseUrl}/mcp/tools`, {
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`daemon /mcp/tools ${r.status}`);
    const body = (await r.json()) as { tools: unknown[] };
    return { tools: body.tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    let body: { content?: string; error?: string; isError?: boolean };
    try {
      const r = await fetch(`${opts.baseUrl}/mcp/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: req.params.name, args: req.params.arguments ?? {} }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!r.ok) {
        return { content: [{ type: 'text', text: `daemon error ${r.status}` }], isError: true };
      }
      body = (await r.json()) as { content?: string; error?: string; isError?: boolean };
    } catch (e) {
      const msg = (e as { name?: string }).name === 'TimeoutError' ? 'daemon timed out' : 'daemon unreachable';
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
    if (body.error) {
      return { content: [{ type: 'text', text: body.error }], isError: true };
    }
    return { content: [{ type: 'text', text: body.content ?? '' }] };
  });

  await server.connect(new StdioServerTransport());
  // stdio transport keeps the process alive until the editor closes the pipe.
}
