/**
 * Bridge an McpTool's input schema (already plain JSON Schema) to a ChatProvider
 * ToolSpec. Strips server-injected props (project_name) so the explorer model
 * never guesses a wrong project — the loop injects the real project_name itself.
 */
import type { McpTool } from '../mcp/tool.js';
import type { ToolSpec } from '@ctx/llm/chat-provider.js';

const INJECTED = new Set(['project_name']);

export function toToolSpec(t: McpTool): ToolSpec {
  const src = t.inputSchema ?? { type: 'object', properties: {} };
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src.properties ?? {})) {
    if (!INJECTED.has(k)) props[k] = v;
  }
  const required = (src.required ?? []).filter((r) => !INJECTED.has(r));
  const parameters: Record<string, unknown> = { type: 'object', properties: props };
  if (required.length) parameters.required = required;
  return { name: t.name, description: t.description, parameters };
}
