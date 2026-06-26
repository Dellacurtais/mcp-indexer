/**
 * Dashboard HTTP server — Hono app mounted on the loopback interface only
 * (127.0.0.1) so AWS credentials are never exposed on the LAN, even though
 * IndexerConfig.dashboard.host defaults to 0.0.0.0 for other future uses.
 *
 * Mounted routes:
 *   /api/projects/*   — list, status, add, index (+ SSE progress)
 *   /api/config       — read/write ~/.code-context/.env (managed keys)
 *   /api/models       — dynamic Bedrock model discovery
 *   /api/config/test-aws
 *   /api/search       — hybrid search playground
 *   /* (fallback)      — static frontend from src/dashboard/public
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectsApp } from './routes/projects.js';
import { configApp } from './routes/config.js';
import { searchApp } from './routes/search.js';
import { copilotApp } from './routes/copilot.js';
import { exploreApp } from './routes/explore.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the public-assets directory. In dev (tsx) this file lives at
 * `src/dashboard/server.ts` so the assets are siblings at `src/dashboard/public`.
 * In a built/published layout this file is at `dist/dashboard/server.js`, but tsc
 * does NOT copy non-TS assets — so the canonical shipped copy is at
 * `<root>/src/dashboard/public` (declared in package.json `files`). We probe both.
 */
function resolvePublicDir(): string {
  const candidates = [
    join(here, 'public'), // dev: src/dashboard/public
    join(here, '..', '..', 'src', 'dashboard', 'public'), // built: dist/dashboard -> src/dashboard/public
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  // fall back to the dev path so the error message is sensible
  return candidates[0];
}

const PUBLIC_DIR = resolvePublicDir();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface DashboardServerOptions {
  port?: number;
  /** When false, do not print the banner line. */
  banner?: boolean;
}

/** Safely serve a file from PUBLIC_DIR, or null if it doesn't exist / escapes. */
async function serveAsset(urlPath: string): Promise<{ body: Buffer; mime: string } | null> {
  // strip leading slash + query/hash, then normalize and guard against traversal
  let rel = urlPath.replace(/^\/+/, '').split('?')[0].split('#')[0];
  if (rel === '') rel = 'index.html';
  const abs = normalize(join(PUBLIC_DIR, rel));
  // prevent path traversal outside PUBLIC_DIR
  if (!abs.startsWith(normalize(PUBLIC_DIR) + sep) && abs !== normalize(PUBLIC_DIR)) return null;
  if (!existsSync(abs)) return null;
  const ext = abs.slice(abs.lastIndexOf('.'));
  const body = await readFile(abs);
  return { body, mime: MIME[ext] ?? 'application/octet-stream' };
}

/** Build (but do not start) the Hono app — exported for testing. */
export function buildDashboardApp(): Hono {
  const app = new Hono();

  // API routes
  app.route('/api/projects', projectsApp);
  app.route('/api', configApp); // /api/config, /api/models, /api/config/test-aws
  app.route('/api', searchApp); // /api/search
  app.route('/api', copilotApp); // /api/copilot/*
  app.route('/api', exploreApp); // /api/explore/runs*

  // Static frontend — manual file serving (robust in both dev and built layouts).
  app.get('*', async (c) => {
    const asset = await serveAsset(c.req.path);
    if (asset) {
      return new Response(asset.body, { headers: { 'Content-Type': asset.mime } });
    }
    // SPA fallback for unknown non-asset paths
    const html = await serveAsset('/index.html');
    if (html) {
      return new Response(html.body, { headers: { 'Content-Type': html.mime } });
    }
    return c.text('dashboard frontend not found — public dir: ' + PUBLIC_DIR, 500);
  });

  return app;
}

/** Start the dashboard server on 127.0.0.1. Returns the http server handle. */
export async function startDashboardServer(opts: DashboardServerOptions = {}): Promise<{
  url: string;
  port: number;
  close: () => Promise<void>;
}> {
  const port = opts.port ?? 8333;
  const app = buildDashboardApp();
  // @hono/node-server types are loose; cast to the shape we need.
  const server = serve({
    fetch: app.fetch,
    hostname: '127.0.0.1', // loopback only — never expose AWS creds on the LAN
    port,
  }) as unknown as { close: (cb?: () => void) => void };

  if (opts.banner !== false) {
    process.stderr.write(`[code-context] dashboard: http://127.0.0.1:${port}\n`);
  }

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
