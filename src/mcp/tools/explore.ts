/**
 * explore — a cheap "explorer" sub-agent exposed as an MCP tool. The calling
 * (expensive) agent delegates a "find / understand / where" investigation; a
 * cheap model configured in the dashboard runs an internal read-only loop and
 * returns a FULL markdown report. This tool's output is UNCAPPED (the report
 * must be complete) — see the `uncapped` flag honored in shaping.ts.
 */
import { defineTool, type McpTool } from '../tool.js';
import { withProject } from './_helpers.js';
import { createChatProvider } from '@ctx/llm/factory.js';
import { resolveExplorerTarget } from '../../agent/model-select.js';
import { runExplorer } from '../../agent/explorer.js';

const DESC =
  'Run a code-explorer sub-agent over THIS project and return a FULL structured markdown report ' +
  '(summary, relevant files+lines, key symbols+signatures, code snippets, dependency edges, next ' +
  'actions). Output is uncapped. It uses a CHEAP model (configured in the dashboard) so YOU spend ' +
  'no tokens exploring. USE for "how does X work", "where is Y", "what calls Z", "map this feature" — ' +
  'not for a trivial single-symbol lookup (use search / get_symbol_body / pack_context for those).';

const explore = defineTool({
  name: 'explore',
  uncapped: true,
  description: DESC,
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      task: { type: 'string', description: 'What to investigate, in plain language.' },
      scope: { type: 'string', description: 'Optional path/dir/glob/module hints to focus the search.' },
    },
    required: ['task'],
  },
  handler: withProject(async (args, ctx, project) => {
    const task = String(args.task ?? '').trim();
    if (!task) return 'explore: `task` is required — describe what to investigate.';

    const target = resolveExplorerTarget();
    if (!target) {
      return (
        'explore: no explorer model configured. Pick one in the dashboard ("Sub-agente explorer") ' +
        'or set CODE_CONTEXT_EXPLORER_PROVIDER=copilot|bedrock and CODE_CONTEXT_EXPLORER_MODEL.'
      );
    }
    if (target.kind === 'copilot' && !ctx.providerStore.getOAuth('copilot')) {
      return 'explore: Copilot is selected for the explorer but not connected — run `code-context login copilot` (or connect it in the dashboard).';
    }

    let provider;
    try {
      provider = createChatProvider(ctx.providerStore, { kind: target.kind, model: target.model, inference: target.inference });
    } catch (e) {
      return `explore: ${e instanceof Error ? e.message : String(e)}`;
    }

    const scope = typeof args.scope === 'string' && args.scope.trim() ? args.scope.trim() : undefined;
    const fullTask = scope ? `${task}\n\nScope hint: ${scope}` : task;

    // Raw (unshaped) registry so the loop dispatches handlers without re-shaping
    // or double project_name injection. Dynamic import avoids a static cycle
    // with tools/index.ts (which registers this tool).
    const { buildToolRegistry } = await import('./index.js');
    const base = buildToolRegistry();

    const res = await runExplorer(
      { provider, registry: base, ctx, projectName: project.name },
      fullTask,
      { onProgress: (e) => process.stderr.write(`[code-context] explore[${e.calls}] ${e.type}:${e.detail}\n`) },
    );

    const footer =
      `\n\n---\n_explored with ${provider.name}:${provider.model} · ${res.toolCalls} tool calls · ` +
      `~$${res.spentUsd.toFixed(4)} · stop: ${res.stopReason}_`;
    return res.report + footer;
  }),
});

export const exploreTools: McpTool[] = [explore];
