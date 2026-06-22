import type { McpTool } from '../tool.js';
import { projectTools } from './projects.js';
import { searchTools } from './search.js';
import { fileTools } from './file.js';
import { symbolTools } from './symbols.js';
import { packTools } from './pack.js';
import { maintenanceTools } from './reindex.js';

/**
 * Retrieval-only MCP tools, grouped by domain. The upstream server also exposed
 * snapshot / misc (cost/admin) / docs-RAG groups; those are dropped here — the
 * code-context server is read-only retrieval. The exact set advertised to a
 * client is further narrowed by the producer-side allowlist in shaping.ts.
 */
export const allTools: McpTool[] = [
  ...projectTools,
  ...searchTools,
  ...fileTools,
  ...symbolTools,
  ...packTools,
  ...maintenanceTools,
];

export function buildToolRegistry(): Map<string, McpTool> {
  const map = new Map<string, McpTool>();
  for (const t of allTools) {
    if (map.has(t.name)) throw new Error(`Duplicate MCP tool name: ${t.name}`);
    map.set(t.name, t);
  }
  return map;
}
