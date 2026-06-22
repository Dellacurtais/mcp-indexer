import { defineTool, type McpTool } from '../tool.js';
import { withProject } from './_helpers.js';
import { runStructuralIndex } from '@ctx/indexer/indexer/structural.js';
import { runEmbedBackfill } from '@ctx/indexer/embed-backfill.js';

/**
 * On-demand (re)index, callable by the agent (Copilot / Claude Code) so the user
 * never has to drop to a terminal. Fire-and-forget: kicks off the structural +
 * embeddings pass in the BACKGROUND and returns immediately, so it never blocks
 * the tool call. A per-project guard prevents overlapping runs. Progress shows up
 * in `get_project_pulse` (vector coverage).
 */
const indexing = new Set<number>();

const reindex = defineTool({
  name: 'reindex',
  description:
    "Build or refresh THIS project's code index (structural symbols + FTS + local embeddings). Runs in the background and returns immediately — call get_project_pulse to watch coverage. Use it when the index is empty or stale (e.g. right after the server starts on a not-yet-indexed repo, or after pulling a lot of changes).",
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' } },
  },
  handler: withProject((_args, ctx, project) => {
    const root = project.root_path;

    if (indexing.has(project.id)) {
      const s = ctx.db.getStats(project.id);
      return `Already indexing ${project.name} — ${s.file_count} files so far. Watch get_project_pulse for coverage.`;
    }

    indexing.add(project.id);
    void (async () => {
      try {
        await runStructuralIndex(ctx.db, project.id, {});
        // No-op when embeddings are disabled (NullVectorStore); otherwise embeds
        // on a worker thread for a large backfill (keeps search responsive).
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
      `Indexing started for ${project.name} (${root}). It runs in the background — ` +
      `call get_project_pulse to watch vector coverage. Currently ${s.file_count} files indexed.`
    );
  }),
});

export const maintenanceTools: McpTool[] = [reindex];
