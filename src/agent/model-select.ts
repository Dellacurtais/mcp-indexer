/**
 * Resolve which provider+model the explorer sub-agent uses. The dashboard writes
 * these to the env-file; `serve` reads them at process start. Falls back to the
 * enrich backend so configuring only enrich gives a working explorer for free.
 */
export interface ExplorerTarget {
  kind: string; // 'copilot' | 'bedrock'
  model?: string;
  inference?: boolean;
}

export function resolveExplorerTarget(env: NodeJS.ProcessEnv = process.env): ExplorerTarget | null {
  const ep = (env.CODE_CONTEXT_EXPLORER_PROVIDER ?? '').trim().toLowerCase();
  if (ep === 'copilot' || ep === 'bedrock') {
    return {
      kind: ep,
      model: env.CODE_CONTEXT_EXPLORER_MODEL?.trim() || undefined,
      inference: env.CODE_CONTEXT_EXPLORER_INFERENCE === '1',
    };
  }
  const ap = (env.CODE_CONTEXT_ANALYSIS ?? '').trim().toLowerCase();
  if (ap === 'copilot' || ap === 'bedrock') {
    return {
      kind: ap,
      model: env.CODE_CONTEXT_ANALYSIS_MODEL?.trim() || undefined,
      inference: env.CODE_CONTEXT_ANALYSIS_INFERENCE === '1',
    };
  }
  return null;
}
