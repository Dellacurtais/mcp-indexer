/**
 * agent_explore / agent_explore_result — a cheap "explorer" SUB-AGENT exposed as
 * MCP tools. The `agent_` prefix flags that these invoke a delegated sub-agent
 * (not a direct retrieval tool like search/grep).
 *
 * The explorer runs a no-turn-limit read-only loop, which can take far longer
 * than the MCP client's per-call timeout (~60s). So it runs as a BACKGROUND JOB:
 *   - `agent_explore` starts the job and LONG-POLLS up to MCP_EXPLORE_POLL_MS. If
 *     the exploration finishes in that window it returns the full report
 *     directly; otherwise it returns a job id to poll.
 *   - `agent_explore_result` long-polls the job and returns the report when
 *     ready, or a progress snapshot to poll again.
 * Each MCP call stays under the client timeout while a deep exploration runs for
 * minutes in the background. Output is UNCAPPED.
 */
import { defineTool, type McpTool } from '../tool.js';
import type { ToolContext } from '../context.js';
import { withProject } from './_helpers.js';
import { createChatProvider } from '@ctx/llm/factory.js';
import { resolveExplorerTarget } from '../../agent/model-select.js';
import { runExplorer } from '../../agent/explorer.js';

interface ExploreJob {
  id: string;
  task: string;
  model: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  toolCalls: number;
  lastTool?: string;
  report?: string;
  error?: string;
  spentUsd: number;
  stopReason?: string;
  done: Promise<void>;
}

const jobs = new Map<string, ExploreJob>();
let jobCounter = 0;

const JOB_TTL_MS = 15 * 60 * 1000;
const MAX_JOBS = 30;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/**
 * How long a single agent_explore / agent_explore_result call blocks waiting for
 * the job. MUST stay comfortably UNDER the MCP client's per-call timeout
 * (commonly 30-60s) so the call RETURNS a "still running, call again" message
 * instead of the client aborting it (-32001). Default 20s; raise
 * MCP_EXPLORE_POLL_MS if your client allows a longer timeout (fewer polls).
 */
const pollWindowMs = (): number => {
  const n = parseInt(process.env.MCP_EXPLORE_POLL_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
};

function reapJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && (j.finishedAt ?? 0) < cutoff) jobs.delete(id);
  }
  if (jobs.size > MAX_JOBS) {
    const finished = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const j of finished) {
      if (jobs.size <= MAX_JOBS) break;
      jobs.delete(j.id);
    }
  }
}

/** Long-poll a job: wait up to the window for it to finish, then describe it. */
async function pollJob(id: string): Promise<string> {
  const job = jobs.get(id);
  if (!job) return `agent_explore_result: unknown job "${id}" (it may have expired, or was already retrieved). Start a new agent_explore.`;
  if (job.status === 'running') await Promise.race([job.done, sleep(pollWindowMs())]);
  if (job.status === 'running') {
    const secs = Math.round((Date.now() - job.startedAt) / 1000);
    return (
      `agent_explore job ${id} still running (${secs}s, ${job.toolCalls} tool calls so far` +
      `${job.lastTool ? `, last: ${job.lastTool}` : ''}). ` +
      `Call agent_explore_result({ job_id: "${id}" }) again to keep waiting for the report.`
    );
  }
  if (job.status === 'error') {
    jobs.delete(id);
    return `agent_explore job ${id} failed: ${job.error}`;
  }
  jobs.delete(id); // one-shot retrieval of the report
  const footer = `\n\n---\n_explored with ${job.model} · ${job.toolCalls} tool calls · ~$${job.spentUsd.toFixed(4)} · stop: ${job.stopReason}_`;
  return (job.report ?? '(explorer produced no report)') + footer;
}

const DESC =
  'Delegate a "find / understand / where" investigation to a CHEAP explorer SUB-AGENT (model set in ' +
  'the dashboard) that runs a read-only loop over THIS project and returns a FULL markdown report ' +
  '(summary, relevant files+lines, key symbols, code snippets, dependency edges, next actions). ' +
  'Output is uncapped — YOU spend no tokens exploring. It runs in the BACKGROUND: this call returns ' +
  'the report if it finishes quickly, otherwise a job id — then call agent_explore_result to get it. ' +
  'USE for "how does X work", "where is Y", "what calls Z", "map this feature"; NOT for a trivial ' +
  'single-symbol lookup (use search / get_symbol_body / pack_context).';

const agentExplore = defineTool({
  name: 'agent_explore',
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
    if (!task) return 'agent_explore: `task` is required — describe what to investigate.';

    const target = resolveExplorerTarget();
    if (!target) {
      return (
        'agent_explore: no explorer model configured. Pick one in the dashboard ("Sub-agente explorer") ' +
        'or set CODE_CONTEXT_EXPLORER_PROVIDER=copilot|bedrock and CODE_CONTEXT_EXPLORER_MODEL.'
      );
    }
    if (target.kind === 'copilot' && !ctx.providerStore.getOAuth('copilot')) {
      return 'agent_explore: Copilot is selected for the explorer but not connected — run `code-context login copilot` (or connect it in the dashboard).';
    }
    let provider;
    try {
      provider = createChatProvider(ctx.providerStore, { kind: target.kind, model: target.model, inference: target.inference });
    } catch (e) {
      return `agent_explore: ${e instanceof Error ? e.message : String(e)}`;
    }

    const scope = typeof args.scope === 'string' && args.scope.trim() ? args.scope.trim() : undefined;
    const fullTask = scope ? `${task}\n\nScope hint: ${scope}` : task;

    reapJobs();
    const id = `exp_${++jobCounter}`;
    let resolveDone!: () => void;
    const job: ExploreJob = {
      id,
      task,
      model: `${provider.name}:${provider.model}`,
      status: 'running',
      startedAt: Date.now(),
      toolCalls: 0,
      spentUsd: 0,
      done: new Promise<void>((r) => (resolveDone = r)),
    };
    jobs.set(id, job);

    // Raw (unshaped) registry so the loop dispatches handlers without re-shaping.
    const { buildToolRegistry } = await import('./index.js');
    const base = buildToolRegistry();

    void runExplorer(
      { provider, registry: base, ctx, projectName: project.name },
      fullTask,
      {
        onProgress: (e) => {
          if (e.type === 'tool') {
            job.toolCalls = e.calls;
            job.lastTool = e.detail;
          }
          process.stderr.write(`[code-context] agent_explore[${e.calls}] ${e.type}:${e.detail}\n`);
        },
      },
    )
      .then((res) => {
        job.status = res.stopReason === 'error' ? 'error' : 'done';
        job.report = res.report;
        job.toolCalls = res.toolCalls;
        job.spentUsd = res.spentUsd;
        job.stopReason = res.stopReason;
        job.finishedAt = Date.now();
        // Persist telemetry (every run, incl. error stops). Never let a persist
        // failure mask the report.
        try {
          ctx.db.insertExploreRun({
            projectId: project.id,
            task: fullTask,
            model: job.model,
            status: job.status,
            stopReason: res.stopReason,
            durationMs: res.durationMs,
            toolCalls: res.toolCalls,
            inputTokens: res.usage.inputTokens,
            outputTokens: res.usage.outputTokens,
            cachedInputTokens: res.usage.cachedInputTokens,
            costUsd: res.spentUsd,
            trail: res.trail,
            report: res.report,
          });
          if (res.spentUsd > 0) {
            ctx.db.insertCost({
              projectId: project.id,
              provider: provider.name,
              model: provider.model,
              operation: 'explore',
              inputTokens: res.usage.inputTokens,
              outputTokens: res.usage.outputTokens,
              costUsd: res.spentUsd,
            });
          }
        } catch (e) {
          process.stderr.write(`[code-context] explore: failed to persist run — ${e instanceof Error ? e.message : String(e)}\n`);
        }
      })
      .catch((e) => {
        // Unexpected throw (runExplorer normally resolves even on 'error' stop).
        job.status = 'error';
        job.error = e instanceof Error ? e.message : String(e);
        job.finishedAt = Date.now();
        try {
          ctx.db.insertExploreRun({
            projectId: project.id,
            task: fullTask,
            model: job.model,
            status: 'error',
            stopReason: 'error',
            durationMs: Date.now() - job.startedAt,
            toolCalls: job.toolCalls,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            costUsd: job.spentUsd,
            trail: [],
            report: `explore failed: ${job.error}`,
          });
        } catch {
          /* ignore */
        }
      })
      .finally(() => resolveDone());

    return pollJob(id); // long-poll: returns the report if it finishes fast, else the job id
  }),
});

const agentExploreResult = defineTool({
  name: 'agent_explore_result',
  uncapped: true,
  description:
    'Fetch the result of a running `agent_explore` job by its job_id. Long-polls and returns the ' +
    'full markdown report when ready, or a progress snapshot to call again. Use this after ' +
    '`agent_explore` returned a job id instead of the report.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      job_id: { type: 'string', description: 'The job id returned by a prior `agent_explore` call.' },
    },
    required: ['job_id'],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolContext) => {
    const id = String(args.job_id ?? '').trim();
    if (!id) return 'agent_explore_result: `job_id` is required (returned by a prior `agent_explore` call).';
    return pollJob(id);
  },
});

export const exploreTools: McpTool[] = [agentExplore, agentExploreResult];
