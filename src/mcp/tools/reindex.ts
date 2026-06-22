import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { defineTool, type McpTool } from '../tool.js';
import { resolveProject } from '../utils.js';
import { runStructuralIndex } from '@ctx/indexer/indexer/structural.js';
import { runEmbedBackfill } from '@ctx/indexer/embed-backfill.js';

/**
 * On-demand (re)index, callable by the agent (Copilot / Claude Code) so the user
 * never has to drop to a terminal. Fire-and-forget: kicks off the structural +
 * embeddings pass in the BACKGROUND and returns immediately. Progress shows up in
 * `get_project_pulse`.
 *
 * By default it indexes the current (served) project. The agent may also pass an
 * explicit `path` to index a specific folder — and we tolerate the common case of
 * the agent putting a filesystem path in `project_name`.
 */
const indexing = new Set<number>();

function looksLikePath(v: unknown): v is string {
  return typeof v === 'string' && (/[\\/]/.test(v) || /^[A-Za-z]:/.test(v));
}

/** Resolve + guard a folder to index (refuse home / drive-root / non-dir). */
function safeRoot(p: string): string {
  const root = path.resolve(p);
  const home = path.resolve(os.homedir());
  const driveRoot = path.resolve(path.parse(root).root || '/');
  if (root === home || root === driveRoot) {
    throw new Error(`refusing to index ${root} — pass a specific project folder`);
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`not a directory: ${root}`);
  }
  return root;
}

const reindex = defineTool({
  name: 'reindex',
  description:
    "Build or refresh a project's code index (structural symbols + FTS + local embeddings). Runs in the background and returns immediately — call get_project_pulse to watch coverage. Indexes the CURRENT project by default; pass `path` (an absolute folder) to index a specific one. Use it when the index is empty or stale.",
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'optional absolute folder to index; defaults to the current project',
      },
      project_name: { type: 'string' },
    },
  },
  handler: (args, ctx) => {
    // Pick the root: explicit `path`, or a path the agent mistakenly put in
    // `project_name`, else the current (served) project resolved by name.
    const explicit =
      typeof args.path === 'string' && args.path.trim()
        ? args.path.trim()
        : looksLikePath(args.project_name)
          ? (args.project_name as string)
          : '';

    let root: string;
    if (explicit) {
      root = safeRoot(explicit);
    } else {
      const proj = resolveProject(ctx.db, args.project_name as string);
      root = proj.root_path;
    }

    const project = ctx.db.getProjectByPath(root) ?? ctx.db.createProject(path.basename(root), root);

    if (indexing.has(project.id)) {
      const s = ctx.db.getStats(project.id);
      return `Already indexing ${project.name} — ${s.file_count} files so far. Watch get_project_pulse for coverage.`;
    }

    indexing.add(project.id);
    void (async () => {
      try {
        await runStructuralIndex(ctx.db, project.id, {});
        await runEmbedBackfill(
          ctx.db,
          { id: project.id, name: project.name },
          root,
          ctx.embeddingService,
          ctx.vectorStore,
        );
      } catch (e) {
        process.stderr.write(
          `[code-context] reindex error: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      } finally {
        indexing.delete(project.id);
      }
    })();

    const s = ctx.db.getStats(project.id);
    return (
      `Indexing started for ${project.name} (${root}) in the background — ` +
      `call get_project_pulse to watch vector coverage. Currently ${s.file_count} files indexed.`
    );
  },
});

export const maintenanceTools: McpTool[] = [reindex];
