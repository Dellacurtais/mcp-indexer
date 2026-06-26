/**
 * runExplorer — a small, purpose-built agent loop. Drives a ChatProvider with
 * the read-only retrieval tools until it emits a final report. By design it has
 * NO turn limit; runaway is bounded by max tool calls + a USD budget + a
 * wall-clock timeout + a doom-loop guard. It can never write or exec (the
 * toolset is a hardcoded read-only allowlist).
 */
import type { ChatProvider, ChatMessage, ChatResult, ToolSpec } from '@ctx/llm/chat-provider.js';
import type { McpTool } from '../mcp/tool.js';
import type { ToolContext } from '../mcp/context.js';
import { toToolSpec } from './tool-schema.js';
import { EXPLORER_SYSTEM, WRAP_UP_INSTRUCTION } from './explorer-prompt.js';

/** Read-only tools the explorer may call. exec/edit tools are never included. */
export const EXPLORER_TOOLSET: readonly string[] = [
  'pack_context',
  'search',
  'grep_code',
  'get_file_skeleton',
  'get_file_structure',
  'read_file',
  'find_references',
  'get_symbol_body',
  'get_dependencies',
  'get_dependents',
  'get_architecture',
  'list_directory',
  'semantic_neighbors',
];

export interface ExplorerDeps {
  provider: ChatProvider;
  registry: Map<string, McpTool>;
  ctx: ToolContext;
  projectName: string;
}

export interface ExplorerOptions {
  toolset?: readonly string[];
  maxToolCalls?: number;
  budgetUsd?: number;
  maxTokens?: number;
  toolOutputChars?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (e: { type: 'tool' | 'turn'; detail: string; calls: number }) => void;
}

export type ExplorerStop = 'final' | 'max-calls' | 'budget' | 'aborted' | 'timeout' | 'no-progress' | 'error';

export interface ExplorerResult {
  report: string;
  toolCalls: number;
  spentUsd: number;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: ExplorerStop;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const numI = (v: string | undefined, d: number): number => {
  const n = v != null ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : d;
};
const numF = (v: string | undefined, d: number): number => {
  const n = v != null ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : d;
};

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n…[tool output truncated to ${max} chars for the explorer]`;
}

export async function runExplorer(
  deps: ExplorerDeps,
  task: string,
  opts: ExplorerOptions = {},
): Promise<ExplorerResult> {
  const env = process.env;
  const toolset = opts.toolset ?? EXPLORER_TOOLSET;
  const maxToolCalls = opts.maxToolCalls ?? numI(env.MCP_EXPLORE_MAX_CALLS, 40);
  const budgetUsd = opts.budgetUsd ?? numF(env.MCP_EXPLORE_BUDGET, 0.5);
  const maxTokens = opts.maxTokens ?? numI(env.MCP_EXPLORE_MAX_TOKENS, 4096);
  const toolOutputChars = opts.toolOutputChars ?? numI(env.MCP_EXPLORE_TOOL_OUTPUT_CHARS, 16_000);
  const timeoutMs = opts.timeoutMs ?? numI(env.MCP_EXPLORE_TIMEOUT_MS, 180_000);
  const onProgress = opts.onProgress ?? (() => {});

  const toolByName = new Map<string, McpTool>();
  for (const name of toolset) {
    const t = deps.registry.get(name);
    if (t) toolByName.set(name, t);
  }
  const tools: ToolSpec[] = [...toolByName.values()].map(toToolSpec);

  // Wall-clock guard (the MCP request may not hand us a signal).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const messages: ChatMessage[] = [
    { role: 'system', content: EXPLORER_SYSTEM },
    { role: 'user', content: task },
  ];

  const price = deps.provider.price();
  let calls = 0;
  let spentUsd = 0;
  const usage = { inputTokens: 0, outputTokens: 0 };
  const recent: string[] = [];

  const accrue = (u: { inputTokens: number; outputTokens: number }): void => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    spentUsd += (u.inputTokens / 1e6) * price.inPerMTok + (u.outputTokens / 1e6) * price.outPerMTok;
  };

  const finalize = async (reason: ExplorerStop): Promise<ExplorerResult> => {
    clearTimeout(timer);
    try {
      messages.push({ role: 'user', content: WRAP_UP_INSTRUCTION });
      const res = await deps.provider.chat(messages, { maxTokens });
      accrue(res.usage);
      return { report: res.text || '(explorer produced no report)', toolCalls: calls, spentUsd, usage, stopReason: reason };
    } catch (e) {
      return { report: `Explorer wrap-up failed: ${errMsg(e)}`, toolCalls: calls, spentUsd, usage, stopReason: 'error' };
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.signal?.aborted) return finalize('aborted');
    if (ac.signal.aborted) return finalize('timeout');

    let res: ChatResult;
    try {
      res = await deps.provider.chat(messages, { tools, maxTokens });
    } catch (e) {
      clearTimeout(timer);
      return { report: `Explorer error: ${errMsg(e)}`, toolCalls: calls, spentUsd, usage, stopReason: 'error' };
    }
    accrue(res.usage);
    onProgress({ type: 'turn', detail: res.finishReason, calls });

    if (!res.toolCalls || res.toolCalls.length === 0) {
      clearTimeout(timer);
      return { report: res.text || '(explorer produced no report)', toolCalls: calls, spentUsd, usage, stopReason: 'final' };
    }

    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });

    for (const tc of res.toolCalls) {
      calls++;
      onProgress({ type: 'tool', detail: tc.name, calls });
      const sig = `${tc.name}:${JSON.stringify(tc.arguments ?? {})}`;
      recent.push(sig);
      if (recent.length > 6) recent.shift();

      const tool = toolByName.get(tc.name);
      let output: string;
      if (!tool) {
        output = `error: tool "${tc.name}" is not available to the explorer (read-only toolset only).`;
      } else {
        try {
          const args = { ...(tc.arguments ?? {}), project_name: deps.projectName };
          const produced = await tool.handler(args, deps.ctx);
          output = clamp(typeof produced === 'string' ? produced : String(produced), toolOutputChars);
        } catch (e) {
          output = `error: ${errMsg(e)}`;
        }
      }
      messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: output });
    }

    if (calls >= maxToolCalls) return finalize('max-calls');
    if (spentUsd >= budgetUsd) return finalize('budget');
    if (recent.length >= 3) {
      const last3 = recent.slice(-3);
      if (last3.every((s) => s === last3[0])) return finalize('no-progress');
    }
  }
}
