import type { McpTool } from '../tool.js';
import { projectTools } from './projects.js';
import { searchTools } from './search.js';
import { fileTools } from './file.js';
import { symbolTools } from './symbols.js';
import { packTools } from './pack.js';
import { maintenanceTools } from './reindex.js';
import { exploreTools } from './explore.js';
import { execTools } from './exec.js';

/**
 * Retrieval-only MCP tools, grouped by domain. The upstream server also exposed
 * snapshot / misc (cost/admin) / docs-RAG groups; those are dropped here — the
 * code-context server is read-only retrieval. The exact set advertised to a
 * client is further narrowed by the producer-side allowlist in shaping.ts.
 *
 * The `exec*` tools are the one exception to read-only: they are registered here
 * but DISABLED by default and only added on top of the read-only set when
 * MCP_EXEC=1 (opt-in) — see resolveAllowlist/execEnabled in shaping.ts.
 */
export const allTools: McpTool[] = [
  ...projectTools,
  ...searchTools,
  ...fileTools,
  ...symbolTools,
  ...packTools,
  ...maintenanceTools,
  ...exploreTools,
  ...execTools,
];

export function buildToolRegistry(): Map<string, McpTool> {
  const map = new Map<string, McpTool>();
  for (const t of allTools) {
    if (map.has(t.name)) throw new Error(`Duplicate MCP tool name: ${t.name}`);
    map.set(t.name, t);
  }
  return map;
}
