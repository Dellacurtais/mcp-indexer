/**
 * /api/search — query an indexed project with the same hybrid pipeline the CLI
 * `search` command uses (see cli/commands/query.ts:102). Opens the project
 * briefly, runs the query, closes in finally (short-lived DB handles).
 */
import { Hono } from 'hono';
import { openProject } from '../../cli/commands/shared.js';
import { disposeIndexerProcessResources } from '@ctx/indexer/bootstrap/dispose.js';

export const searchApp = new Hono();

interface SearchHit {
  type: 'file' | 'symbol';
  score: number;
  data: Record<string, unknown>;
}

searchApp.post('/search', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    projectId?: number;
    rootPath?: string;
    query?: string;
    mode?: 'auto' | 'fts' | 'vector' | 'hybrid';
    type?: 'files' | 'symbols' | 'all';
    limit?: number;
  };

  if (!body.query || !body.query.trim()) return c.json({ error: 'query required' }, 400);

  // Resolve the project: by id lookup of its root, or by explicit rootPath.
  let root: string | undefined = body.rootPath;
  if (!root && body.projectId !== undefined) {
    const { CodeIndexDB } = await import('@ctx/store/db.js');
    const { loadConfig } = await import('@ctx/shared/utils/config.js');
    const d = new CodeIndexDB(loadConfig().dbPath);
    try {
      const p = d.getProject(Number(body.projectId));
      root = p?.root_path;
    } finally {
      d.close();
    }
  }
  if (!root) return c.json({ error: 'projectId or rootPath required' }, 400);

  let resolvedRoot: string;
  try {
    const { resolveRoot } = await import('../../cli/commands/shared.js');
    resolvedRoot = resolveRoot(root);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }

  const opened = openProject(resolvedRoot, {});
  try {
    if ((opened.db.getStats(opened.project.id).file_count ?? 0) === 0) {
      return c.json({ error: 'project not indexed yet', results: [] as SearchHit[] });
    }
    const raw = await opened.ctx.hybridSearch.search(
      opened.project.id,
      opened.project.name,
      body.query,
      {
        mode: body.mode ?? 'auto',
        type: body.type ?? 'all',
        limit: Math.max(1, Math.min(body.limit ?? 15, 50)),
      },
    );
    const results: SearchHit[] = raw.map((r) => ({
      type: r.type as 'file' | 'symbol',
      score: r.score,
      data: r.data as unknown as Record<string, unknown>,
    }));
    return c.json({ results, project: opened.project.name });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e), results: [] as SearchHit[] },
      500,
    );
  } finally {
    try {
      await disposeIndexerProcessResources();
    } catch {
      /* ignore */
    }
    opened.db.close();
  }
});
