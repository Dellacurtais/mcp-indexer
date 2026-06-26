/**
 * /api/explore/runs — browse agent_explore telemetry (one row per run): the
 * tool-call trail, token usage (incl. cached), cost, duration, stop reason, and
 * the full markdown report. Short-lived DB handles, like the other routes.
 */
import { Hono } from 'hono';
import { CodeIndexDB } from '@ctx/store/db.js';
import { loadConfig } from '@ctx/shared/utils/config.js';

export const exploreApp = new Hono();

function db(): CodeIndexDB {
  return new CodeIndexDB(loadConfig().dbPath);
}

/** GET /api/explore/runs?projectId=&limit= — newest-first list (no heavy report/trail). */
exploreApp.get('/explore/runs', (c) => {
  const projectId = Number(c.req.query('projectId'));
  if (!Number.isFinite(projectId)) return c.json({ error: 'projectId required' }, 400);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
  const d = db();
  try {
    return c.json({ runs: d.listExploreRuns(projectId, limit) });
  } finally {
    d.close();
  }
});

/** GET /api/explore/runs/:id — full run (report + tool-call trail). */
exploreApp.get('/explore/runs/:id', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
  const d = db();
  try {
    const run = d.getExploreRun(id);
    if (!run) return c.json({ error: 'not found' }, 404);
    return c.json({ run });
  } finally {
    d.close();
  }
});
