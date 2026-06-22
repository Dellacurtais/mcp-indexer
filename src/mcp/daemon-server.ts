/**
 * Daemon HTTP API (loopback only).
 *
 * The long-running daemon serves the shaped, curated tool registry over a tiny
 * JSON API. The per-editor stdio shim (shim.ts) translates MCP requests into
 * calls against this API, so a single warm index/watch process is shared across
 * editors. This is deliberately NOT the MCP wire protocol — the shim owns the
 * MCP surface; this is just the broker transport between shim and daemon.
 *
 *   GET  /health      → { ok, server, project, root, tools }
 *   GET  /mcp/tools   → { tools: [{ name, description, inputSchema }] }
 *   POST /mcp/call    → { content } | { error, isError }   body: { name, args }
 */
import http from 'node:http';
import type { McpTool } from './tool.js';
import type { ToolContext } from './context.js';

export interface DaemonServer {
  port: number;
  close(): Promise<void>;
}

export interface DaemonInfo {
  serverName: string;
  project: string;
  root: string;
}

/**
 * Scrub a tool error before returning it to the editor: drop absolute paths and
 * any source-product identifiers so an exception string can't leak the origin.
 * The full detail is logged to the daemon's stderr instead.
 */
function scrubError(msg: string): string {
  return msg
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, '<path>') // Windows abs paths
    .replace(/(?:\/[\w.@-]+){2,}/g, '<path>') // POSIX abs paths
    .replace(/@(?:mcp|ctx)\/[\w/-]+/gi, '<module>')
    .replace(/mcp-code-indexer|codestudio/gi, 'code-context');
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export function startDaemonHttp(
  registry: Map<string, McpTool>,
  ctx: ToolContext,
  info: DaemonInfo,
): Promise<DaemonServer> {
  const toolDefs = [...registry.values()].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    void (async () => {
      try {
        if (req.method === 'GET' && req.url === '/health') {
          return send(200, {
            ok: true,
            server: info.serverName,
            project: info.project,
            root: info.root,
            tools: toolDefs.length,
          });
        }
        if (req.method === 'GET' && req.url === '/mcp/tools') {
          return send(200, { tools: toolDefs });
        }
        if (req.method === 'POST' && req.url === '/mcp/call') {
          const body = await readJsonBody(req);
          const name = String(body.name ?? '');
          const tool = registry.get(name);
          if (!tool) return send(404, { error: `unknown tool: ${name}` });
          try {
            const args = (body.args ?? {}) as Record<string, unknown>;
            const out = await tool.handler(args, ctx);
            return send(200, { content: typeof out === 'string' ? out : String(out) });
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            console.error(`[code-context] tool "${name}" error: ${detail}`);
            return send(200, { error: scrubError(detail), isError: true });
          }
        }
        send(404, { error: 'not found' });
      } catch (e) {
        send(500, { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });

  return new Promise((resolve) => {
    // port 0 → OS picks a free loopback port
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.(); // don't wait on idle keep-alive sockets
            server.close(() => r());
          }),
      });
    });
  });
}
