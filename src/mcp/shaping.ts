/**
 * Producer-side output shaping — the "token economy" delivered to Copilot.
 *
 * Wraps each MCP tool handler so its returned text passes through the same
 * deterministic smart-reducers + output caps the in-house agent applies on the
 * consumer side, and curates a read-only allowlist. Also injects the single
 * project's name server-side so the client never has to supply `project_name`.
 *
 * Order (cache-stable, all deterministic): tool's own clamp → smart reducer →
 * output cap (byte fail-safe).
 */
import type { McpTool } from './tool.js';
import { applySmartReducer } from '@ctx/reducers/smart-reducers.js';
import {
  capFor,
  parseToolOutputCapLevel,
  type ToolOutputCapLevel,
} from '@ctx/reducers/runner/output-caps.js';

/** Per-tool base byte budget (the `base` fed to capFor). Dense by default so
 *  Copilot gets compact output even when it omits an explicit limit. */
const DEFAULT_BASE = 12_000;
const TOOL_BASE: Record<string, number> = {
  get_project_pulse: 2_000,
  get_project_stats: 2_000,
  get_project_overview: 8_000,
  get_repo_map: 8_000,
  get_architecture: 8_000,
  search: 6_000,
  grep_code: 6_000,
  search_concepts: 6_000,
  search_by_kind: 4_000,
  semantic_neighbors: 4_000,
  get_file_skeleton: 6_000,
  get_file_structure: 4_000,
  read_file: 24_000,
  pack_context: 8_000,
  exec_command: 24_000,
};
const CEILING = 1_000_000;

/** Read-only retrieval surface advertised to the client. */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  'get_project_pulse',
  'get_project_overview',
  'get_project_stats',
  'get_repo_map',
  'get_architecture',
  'search',
  'grep_code',
  'search_by_kind',
  'search_concepts',
  'semantic_neighbors',
  'get_file_skeleton',
  'get_file_structure',
  'read_file',
  'find_references',
  'get_symbol_body',
  'get_class_members',
  'get_hierarchy',
  'find_implementations',
  'prepare_edit',
  'list_directory',
  'get_dependencies',
  'get_dependents',
  'pack_context',
  'explore',
  'reindex',
];

/**
 * Lean default surface — one high-value tool per stage of the orient→search→drill
 * →navigate→graph flow. Agents (Copilot especially) pick tools more accurately
 * from a small, well-named set; the full surface is opt-in via `MCP_TOOLS=full`.
 */
export const CORE_ALLOWLIST: readonly string[] = [
  'pack_context',
  'get_project_pulse',
  'get_architecture',
  'search',
  'grep_code',
  'get_file_skeleton',
  'read_file',
  'find_references',
  'get_symbol_body',
  'get_dependencies',
  'explore',
  'reindex',
];

/** The opt-in exec tools — NEVER part of the read-only set; only added on top. */
export const EXEC_ALLOWLIST: readonly string[] = ['exec_command', 'write_stdin', 'list_sessions'];

/**
 * The READ-ONLY surface `serve` advertises. `MCP_TOOLS`: unset/`core` →
 * CORE_ALLOWLIST; `full`/`all` → the whole read-only surface; or a comma list of
 * exact read-only tool names (intersected with the known set; never empty).
 */
export function resolveReadAllowlist(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = (env.MCP_TOOLS ?? '').trim().toLowerCase();
  if (!raw || raw === 'core') return CORE_ALLOWLIST;
  if (raw === 'full' || raw === 'all') return DEFAULT_ALLOWLIST;
  const known = new Set(DEFAULT_ALLOWLIST);
  const picked = raw.split(',').map((s) => s.trim()).filter((s) => known.has(s));
  return picked.length ? picked : CORE_ALLOWLIST;
}

/**
 * Is the opt-in exec surface enabled? ONLY via an explicit opt-in — `MCP_EXEC=1`
 * (the dashboard toggle) or naming an exec tool in an `MCP_TOOLS` comma list.
 * `full`/`all` deliberately do NOT enable exec (they mean "full read-only").
 */
export function execEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.MCP_EXEC ?? '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  const raw = (env.MCP_TOOLS ?? '').trim().toLowerCase();
  if (!raw || raw === 'core' || raw === 'full' || raw === 'all') return false;
  const named = new Set(raw.split(',').map((s) => s.trim()));
  return EXEC_ALLOWLIST.some((t) => named.has(t));
}

/**
 * The full advertised set = read-only surface, plus the exec tools when (and
 * only when) explicitly opted in. The union guarantees exec can never replace
 * the read-only tools — it only ever coexists with them.
 */
export function resolveAllowlist(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const read = resolveReadAllowlist(env);
  return execEnabled(env) ? [...read, ...EXEC_ALLOWLIST] : read;
}

export interface ShapeOptions {
  level?: ToolOutputCapLevel;
  /** Injected as `project_name` when a tool declares that input and the caller omits it. */
  projectName?: string;
  allowlist?: readonly string[];
}

export function resolveCapLevel(explicit?: ToolOutputCapLevel): ToolOutputCapLevel {
  return explicit ?? parseToolOutputCapLevel(process.env.MCP_OUTPUT_CAP_LEVEL) ?? 'economic';
}

export function shapeRegistry(
  registry: Map<string, McpTool>,
  opts: ShapeOptions = {},
): Map<string, McpTool> {
  const level = resolveCapLevel(opts.level);
  const allow = new Set(opts.allowlist ?? resolveAllowlist());
  const out = new Map<string, McpTool>();
  for (const [name, tool] of registry) {
    if (!allow.has(name)) continue;
    out.set(name, wrap(tool, level, opts.projectName));
  }
  return out;
}

function wrap(tool: McpTool, level: ToolOutputCapLevel, projectName?: string): McpTool {
  const wantsProject =
    !!tool.inputSchema?.properties && 'project_name' in tool.inputSchema.properties;

  // Uncapped tools (e.g. `explore`) keep project_name injection but skip the
  // smart reducer + byte cap — their full payload IS the point.
  if (tool.uncapped) {
    return {
      ...tool,
      handler: async (rawArgs, ctx, authCtx) => {
        let args = rawArgs;
        if (projectName && wantsProject && (args.project_name == null || args.project_name === '')) {
          args = { ...args, project_name: projectName };
        }
        const produced = await tool.handler(args, ctx, authCtx);
        return typeof produced === 'string' ? produced : String(produced);
      },
    };
  }

  const base = TOOL_BASE[tool.name] ?? DEFAULT_BASE;
  const cap = capFor(level, base, CEILING);
  return {
    ...tool,
    handler: async (rawArgs, ctx, authCtx) => {
      let args = rawArgs;
      if (projectName && wantsProject && (args.project_name == null || args.project_name === '')) {
        args = { ...args, project_name: projectName };
      }
      const produced = await tool.handler(args, ctx, authCtx);
      const text = typeof produced === 'string' ? produced : String(produced);
      const query =
        typeof args.query === 'string'
          ? args.query
          : typeof args.pattern === 'string'
            ? args.pattern
            : undefined;
      const reduced = applySmartReducer(tool.name, text, cap, { query });
      if (reduced.length <= cap) return reduced;
      // Byte-slice fail-safe — but NEVER on a structured (JSON) payload: many tools
      // return a JSON document in format="json" mode, and a mid-object cut would
      // hand the client unparseable JSON. The smart reducer already shrinks arrays;
      // an over-cap single JSON object is returned whole rather than corrupted.
      const looksJson = /^\s*[[{]/.test(reduced);
      if (looksJson) return reduced;
      return reduced.slice(0, cap) + `\n…[truncated to ${cap} chars]`;
    },
  };
}
