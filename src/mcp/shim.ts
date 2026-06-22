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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const r = await fetch(`${opts.baseUrl}/mcp/tools`);
    if (!r.ok) throw new Error(`daemon /mcp/tools ${r.status}`);
    const body = (await r.json()) as { tools: unknown[] };
    return { tools: body.tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await fetch(`${opts.baseUrl}/mcp/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: req.params.name,
        args: req.params.arguments ?? {},
      }),
    });
    if (!r.ok) {
      return { content: [{ type: 'text', text: `daemon error ${r.status}` }], isError: true };
    }
    const body = (await r.json()) as { content?: string; error?: string; isError?: boolean };
    if (body.error) {
      return { content: [{ type: 'text', text: body.error }], isError: true };
    }
    return { content: [{ type: 'text', text: body.content ?? '' }] };
  });

  await server.connect(new StdioServerTransport());
  // stdio transport keeps the process alive until the editor closes the pipe.
}
