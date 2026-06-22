import type { SearchDiagnostics } from '@ctx/indexer/search/hybrid.js';

/** Subset of EmbeddingCoverage the trailer needs (lazy — only on zero/degraded results). */
export interface CoverageCounts {
  files_total: number;
  files_embedded: number;
  /**
   * Files whose semantic layer (LLM summary/embeddings) lags current content
   * — structurally re-indexed by the watcher/auto-index but not yet seen by
   * a full run. Optional: older callers don't compute it.
   */
  files_semantic_stale?: number;
}

/**
 * Why the vector stream contributed nothing, as a stable reason code the
 * agent can act on. Null when the vector path looked healthy.
 */
export function vectorIssue(diag: SearchDiagnostics): string | null {
  if (!diag.vectorAvailable) return 'vector_store_unavailable';
  if (!diag.embeddingAvailable) return 'embedding_unavailable';
  if (diag.vectorError) return `vector_error: ${diag.vectorError}`;
  return null;
}

function describeMode(requestedMode: string, diag: SearchDiagnostics): string {
  if (diag.plannerMode) return `${diag.plannerMode} (planner: ${diag.plannerReason ?? 'auto'})`;
  return requestedMode;
}

/**
 * Replacement for the bare 'No results found.' — tells the agent WHAT ran
 * and what was degraded, so "zero results" can be read as "the healthy
 * streams found nothing" vs "the semantic stream never ran". Without this,
 * agents concluded "the code doesn't exist" when embeddings were down or
 * files were tier-excluded from embedding.
 */
export function renderZeroResultDiagnostics(
  requestedMode: string,
  diag: SearchDiagnostics,
  getCoverage: () => CoverageCounts,
): string {
  const issue = vectorIssue(diag);
  const parts = [
    `mode=${describeMode(requestedMode, diag)}`,
    diag.ftsCount !== undefined ? `fts_hits=${diag.ftsCount}` : null,
    issue ? `vector=failed: ${issue}` : `vector=ok (raw_matches=${diag.vectorRawMatches ?? 0})`,
  ].filter(Boolean);

  const lines = ['No results found.', `[diagnostics] ${parts.join(' | ')}`];
  if (issue) {
    lines.push(
      'Semantic search did not run for this query — absence here does NOT mean the code does not exist. Use grep_code (exact text, has disk fallback) before concluding anything is missing.',
    );
  }

  const cov = safeCoverage(getCoverage);
  if (cov && cov.files_total === 0) {
    // No structural index at all — symbols/FTS/content are all empty.
    lines.push(
      'This project has NO index yet (not even the structural layer) — zero results are meaningless. Open the project to trigger the auto structural index, or run indexing manually; grep_code disk fallback works meanwhile.',
    );
  } else if (cov && cov.files_total > 0 && cov.files_embedded === 0) {
    // Structural-only ("dumb mode"): symbols + FTS + content index work,
    // semantic summaries/embeddings don't exist yet.
    lines.push(
      'Index is STRUCTURAL-ONLY (symbols/FTS/content — no LLM summaries, no embeddings yet). Prefer exact identifiers or grep_code; semantic absence is NOT evidence of absence.',
    );
  } else if (cov && cov.files_total > 0 && cov.files_embedded < cov.files_total) {
    // Tier-coverage honesty: under the aggressive profile, on_demand files
    // (tests/docs/migrations/fixtures) are indexed for FTS but never embedded.
    lines.push(
      `Embeddings cover ${cov.files_embedded}/${cov.files_total} indexed files — semantic search cannot see the rest (e.g. on_demand-tier files under the aggressive profile); grep_code covers them.`,
    );
  }
  if (cov?.files_semantic_stale && cov.files_semantic_stale > 0) {
    lines.push(
      `${cov.files_semantic_stale} file(s) changed since the last semantic pass (summaries/embeddings stale there) — structural data (symbols/grep) is current.`,
    );
  }
  return lines.join('\n');
}

/**
 * One-line trailer appended to NON-empty results when the vector stream
 * failed: the hits are FTS-only, so the agent should calibrate confidence
 * (a missing semantic match is not evidence of absence).
 */
export function renderDegradedTrailer(diag: SearchDiagnostics): string | null {
  const issue = vectorIssue(diag);
  if (!issue) return null;
  return `[note: vector search failed (${issue}) — results above are FTS-only; semantic misses are not evidence of absence]`;
}

function safeCoverage(getCoverage: () => CoverageCounts): CoverageCounts | null {
  try {
    return getCoverage();
  } catch {
    return null; // diagnostics must never break the search result itself
  }
}
