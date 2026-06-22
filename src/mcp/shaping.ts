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
  'reindex',
];

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
  const allow = new Set(opts.allowlist ?? DEFAULT_ALLOWLIST);
  const out = new Map<string, McpTool>();
  for (const [name, tool] of registry) {
    if (!allow.has(name)) continue;
    out.set(name, wrap(tool, level, opts.projectName));
  }
  return out;
}

function wrap(tool: McpTool, level: ToolOutputCapLevel, projectName?: string): McpTool {
  const base = TOOL_BASE[tool.name] ?? DEFAULT_BASE;
  const cap = capFor(level, base, CEILING);
  const wantsProject =
    !!tool.inputSchema?.properties && 'project_name' in tool.inputSchema.properties;
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
