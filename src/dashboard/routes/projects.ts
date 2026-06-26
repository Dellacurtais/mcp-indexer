/**
 * /api/projects — list, status, add, and index projects.
 * Indexing runs as a spawned CLI child (see child-runner.ts) for fault isolation;
 * progress is streamed over SSE on /api/projects/:id/index/stream.
 */
import { Hono } from 'hono';
import path from 'node:path';
import { CodeIndexDB } from '@ctx/store/db.js';
import { loadConfig } from '@ctx/shared/utils/config.js';
import { resolveRoot } from '../../cli/commands/shared.js';
import { startIndexRun, getActiveRun, setActiveRun, type ProgressEvent } from '../child-runner.js';

export const projectsApp = new Hono();

function db(): CodeIndexDB {
  return new CodeIndexDB(loadConfig().dbPath);
}

/** GET /api/projects — every indexed project (read-only). */
projectsApp.get('/', (c) => {
  const d = db();
  try {
    const projects = d.listProjects().map((p) => ({
      id: p.id,
      name: p.name,
      root_path: p.root_path,
      file_count: p.file_count ?? 0,
      symbol_count: p.symbol_count ?? 0,
      last_indexed: p.last_indexed ?? null,
    }));
    return c.json({ projects });
  } finally {
    d.close();
  }
});

/** GET /api/projects/:id/status — coverage + cost snapshot. */
projectsApp.get('/:id/status', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
  const d = db();
  try {
    const project = d.getProject(id);
    if (!project) return c.json({ error: 'project not found' }, 404);
    const stats = d.getStats(project.id);
    const coverage = d.getEmbeddingCoverage(project.id);
    const stale = d.countSemanticStale(project.id);
    const cost = d.getCostSummary(project.id);
    return c.json({
      project: { id: project.id, name: project.name, root_path: project.root_path },
      stats: {
        file_count: stats.file_count,
        symbol_count: stats.symbol_count,
        total_lines: stats.total_lines,
        languages: stats.languages,
        last_indexed: stats.last_indexed,
        semantic_stale: stale,
      },
      coverage: {
        files: { embedded: coverage.files_embedded, total: coverage.files_total },
        symbols: { embedded: coverage.symbols_embedded, total: coverage.symbols_total },
        bodies: { embedded: coverage.symbol_bodies_embedded, total: coverage.symbol_bodies_total },
      },
      cost: {
        total_usd: cost.total_cost_usd ?? 0,
        analysis_usd: cost.llm_analysis_cost_usd ?? 0,
      },
    });
  } finally {
    d.close();
  }
});

/** POST /api/projects — register a new project folder (does not index). */
projectsApp.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { rootPath?: string };
  if (!body.rootPath || !body.rootPath.trim()) return c.json({ error: 'rootPath required' }, 400);
  let root: string;
  try {
    root = resolveRoot(body.rootPath.trim());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  const d = db();
  try {
    const existing = d.getProjectByPath(root);
    const project = existing ?? d.createProject(path.basename(root), root);
    return c.json({
      project: { id: project.id, name: project.name, root_path: project.root_path },
      already_existed: !!existing,
    });
  } finally {
    d.close();
  }
});

/** POST /api/projects/:id/index — kick off a child indexing run. */
projectsApp.post('/:id/index', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { noEmbeddings?: boolean };

  const d = db();
  let root: string;
  try {
    const project = d.getProject(id);
    if (!project) return c.json({ error: 'project not found' }, 404);
    root = project.root_path;
  } finally {
    d.close();
  }

  if (getActiveRun(id)) return c.json({ error: 'an indexing run is already active for this project' }, 409);

  // SSE subscribers for this run (kept in a module-level map; the stream route reads it).
  const run = startIndexRun(root, { noEmbeddings: !!body.noEmbeddings }, (ev) => {
    pushEvent(id, run.runId, ev);
  });
  setActiveRun(id, run);
  return c.json({ runId: run.runId });
});

/** GET /api/projects/:id/index/stream?runId= — Server-Sent Events progress. */
projectsApp.get('/:id/index/stream', (c) => {
  const id = Number(c.req.param('id'));
  const runId = c.req.query('runId');
  const active = getActiveRun(id);
  if (!active || active.runId !== runId) {
    return c.text('run not found', 404);
  }
  // Register this stream and drain buffered + future events until the child exits.
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (ev: ProgressEvent) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        if (ev.type === 'done') {
          controller.close();
          off(id, runId, send);
          if (getActiveRun(id)?.runId === runId) setActiveRun(id, undefined);
        }
      };
      on(id, runId, send);
      // Heartbeat keeps the connection alive through proxies that idle fast.
      const hb = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          /* already closed */
        }
      }, 15000);
      // cleanup if the client disconnects before `done`
      c.req.raw.signal?.addEventListener('abort', () => {
        clearInterval(hb);
        off(id, runId, send);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
});

// ─── per-run event fan-out ────────────────────────────────────────────────────
type Listener = (ev: ProgressEvent) => void;
const listeners = new Map<string, Set<Listener>>();
const buffer = new Map<string, ProgressEvent[]>();

function key(projectId: number, runId: string): string {
  return `${projectId}:${runId}`;
}
function on(projectId: number, runId: string, fn: Listener): void {
  const k = key(projectId, runId);
  if (!listeners.has(k)) listeners.set(k, new Set());
  listeners.get(k)!.add(fn);
  // replay buffered events (late subscriber)
  for (const ev of buffer.get(k) ?? []) fn(ev);
}
function off(projectId: number, runId: string, fn: Listener): void {
  const k = key(projectId, runId);
  listeners.get(k)?.delete(fn);
  if (listeners.get(k)?.size === 0) {
    listeners.delete(k);
    buffer.delete(k);
  }
}
function pushEvent(projectId: number, runId: string, ev: ProgressEvent): void {
  const k = key(projectId, runId);
  const set = listeners.get(k);
  if (set && set.size > 0) {
    for (const fn of set) fn(ev);
  } else {
    // no subscriber yet; buffer up to 64 events for replay
    const arr = buffer.get(k) ?? [];
    arr.push(ev);
    if (arr.length > 64) arr.shift();
    buffer.set(k, arr);
  }
}
