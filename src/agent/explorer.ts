/**
 * runExplorer — a small, purpose-built agent loop. Drives a ChatProvider with
 * the read-only retrieval tools until it emits a final report. By design it has
 * NO turn limit; runaway is bounded by max tool calls + a USD budget + a
 * wall-clock timeout + a doom-loop guard. It can never write or exec (the
 * toolset is a hardcoded read-only allowlist).
 *
 * It NEVER loses work: the report is built from the accumulated transcript, so a
 * failed/empty model synthesis falls back to the gathered evidence rather than
 * returning nothing. It also captures a per-tool-call trail + token usage
 * (incl. cached) for telemetry.
 */
import type { ChatProvider, ChatMessage, ChatResult, ToolSpec, ChatUsage } from '@ctx/llm/chat-provider.js';
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

/** One entry in the explorer's tool-call trail (telemetry; summarized). */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  ms: number;
  ok: boolean;
  outputBytes: number;
  snippet: string;
}

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
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  trail: ToolCallRecord[];
  durationMs: number;
  stopReason: ExplorerStop;
}

const TRAIL_SNIPPET = 3_000;

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
  return s.length <= max ? s : s.slice(0, max) + `\n…[truncated to ${max} chars]`;
}

function compactArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 140 ? s.slice(0, 137) + '…' : s;
  } catch {
    return '';
  }
}

/**
 * Build a usable report from the accumulated transcript — the guarantee that the
 * explorer NEVER loses its work when the model's synthesis is empty/failed.
 */
function buildTranscriptReport(task: string, messages: ChatMessage[]): string {
  const callMeta = new Map<string, { name: string; args: Record<string, unknown> }>();
  const notes: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if (m.content && m.content.trim()) notes.push(m.content.trim());
    for (const tc of m.toolCalls ?? []) callMeta.set(tc.id, { name: tc.name, args: tc.arguments ?? {} });
  }

  const sections: string[] = [];
  let n = 0;
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    n++;
    const meta = m.toolCallId ? callMeta.get(m.toolCallId) : undefined;
    const name = meta?.name ?? m.name ?? 'tool';
    const argStr = meta ? compactArgs(meta.args) : '';
    sections.push(`### ${n}. ${name}${argStr ? `(${argStr})` : ''}\n\n${clamp(m.content ?? '', 4_000)}`);
  }

  const head = [
    '# Exploration capture (partial — the model did not return a synthesized report)',
    '',
    `**Task:** ${task}`,
    '',
    `The explorer's final synthesis came back empty, so here is the raw evidence it gathered across ${n} tool call(s). Use it directly.`,
  ];
  if (notes.length) head.push('', '## Explorer notes', ...notes.map((x) => `- ${x}`));
  if (n === 0) {
    head.push('', '_(No tool results were gathered — the model returned nothing. Try a faster, non-reasoning model for the explorer.)_');
    return head.join('\n');
  }
  return [...head, '', '## Gathered findings (raw tool outputs)', ...sections].join('\n');
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
  const reportTokens = Math.max(maxTokens, numI(env.MCP_EXPLORE_REPORT_TOKENS, 8192));
  const toolOutputChars = opts.toolOutputChars ?? numI(env.MCP_EXPLORE_TOOL_OUTPUT_CHARS, 16_000);
  const timeoutMs = opts.timeoutMs ?? numI(env.MCP_EXPLORE_TIMEOUT_MS, 180_000);
  const onProgress = opts.onProgress ?? (() => {});

  const startedAt = Date.now();
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
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const trail: ToolCallRecord[] = [];
  const recent: string[] = [];

  const accrue = (u: ChatUsage): void => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cachedInputTokens += u.cachedInputTokens ?? 0;
    spentUsd += (u.inputTokens / 1e6) * price.inPerMTok + (u.outputTokens / 1e6) * price.outPerMTok;
  };

  const done = (report: string, reason: ExplorerStop): ExplorerResult => {
    clearTimeout(timer);
    return { report, toolCalls: calls, spentUsd, usage, trail, durationMs: Date.now() - startedAt, stopReason: reason };
  };

  // Wrap-up: ask for the report with a bigger budget + one retry; ALWAYS fall back
  // to the transcript so a blank/failed synthesis never loses the gathered work.
  const finalize = async (reason: ExplorerStop): Promise<ExplorerResult> => {
    const wrap = async (instruction: string): Promise<string> => {
      messages.push({ role: 'user', content: instruction });
      const res = await deps.provider.chat(messages, { maxTokens: reportTokens });
      accrue(res.usage);
      return (res.text ?? '').trim();
    };
    let text = '';
    try {
      text = await wrap(WRAP_UP_INSTRUCTION);
      if (!text) {
        text = await wrap('Output the final report NOW as plain markdown using the required sections. Do not call tools or reason further.');
      }
    } catch (e) {
      onProgress({ type: 'turn', detail: `wrap-up error: ${errMsg(e)}`, calls });
    }
    return done(text || buildTranscriptReport(task, messages), reason);
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.signal?.aborted) return finalize('aborted');
    if (ac.signal.aborted) return finalize('timeout');

    let res: ChatResult;
    try {
      res = await deps.provider.chat(messages, { tools, maxTokens });
    } catch (e) {
      // Preserve whatever was gathered + surface the error.
      const report = `Explorer error: ${errMsg(e)}\n\n` + buildTranscriptReport(task, messages);
      return done(report, 'error');
    }
    accrue(res.usage);
    onProgress({ type: 'turn', detail: res.finishReason, calls });

    if (!res.toolCalls || res.toolCalls.length === 0) {
      const report = (res.text ?? '').trim() || buildTranscriptReport(task, messages);
      return done(report, 'final');
    }

    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });

    for (const tc of res.toolCalls) {
      calls++;
      onProgress({ type: 'tool', detail: tc.name, calls });
      const sig = `${tc.name}:${JSON.stringify(tc.arguments ?? {})}`;
      recent.push(sig);
      if (recent.length > 6) recent.shift();

      const tStart = Date.now();
      const tool = toolByName.get(tc.name);
      let output: string;
      let ok = true;
      if (!tool) {
        output = `error: tool "${tc.name}" is not available to the explorer (read-only toolset only).`;
        ok = false;
      } else {
        try {
          const args = { ...(tc.arguments ?? {}), project_name: deps.projectName };
          const produced = await tool.handler(args, deps.ctx);
          output = clamp(typeof produced === 'string' ? produced : String(produced), toolOutputChars);
        } catch (e) {
          output = `error: ${errMsg(e)}`;
          ok = false;
        }
      }
      trail.push({
        name: tc.name,
        args: tc.arguments ?? {},
        ms: Date.now() - tStart,
        ok,
        outputBytes: output.length,
        snippet: clamp(output, TRAIL_SNIPPET),
      });
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
