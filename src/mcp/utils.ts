import type { CodeIndexDB } from '@ctx/store/db.js';

export function resolveProject(db: CodeIndexDB, name: string) {
  const project = db.getProjectByName(name);
  if (!project) throw new Error(`Project "${name}" not found. Use list_projects to see available projects.`);
  return project;
}

export function truncateToTokens(text: string, maxTokens?: number): string {
  if (!maxTokens || maxTokens <= 0) return text;
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n... [truncated to ~${maxTokens} tokens]`;
}

/**
 * Some MCP clients stringify numbers and booleans in tool arguments.
 * Normalize common scalar types so handlers can treat `args.limit` as
 * a number regardless of wire format.
 */
export function coerceArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      if (v === 'true') { out[k] = true; continue; }
      if (v === 'false') { out[k] = false; continue; }
      if (/^-?\d+(\.\d+)?$/.test(v)) { out[k] = Number(v); continue; }
    }
    out[k] = v;
  }
  return out;
}
