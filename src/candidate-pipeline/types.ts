/**
 * Core types for the candidate-pipeline framework.
 *
 * Translated from `xai-org/x-algorithm/candidate-pipeline` Rust crate.
 * Each trait has the same execution invariants as its Rust counterpart:
 *
 *   - QueryHydrator: parallel (`join_all`)
 *   - Source:        parallel
 *   - Hydrator:      parallel
 *   - Filter:        sequential (kept feeds next filter)
 *   - Scorer:        sequential async, **order-preserving**
 *   - Selector:      single, top-K
 *   - SideEffect:    fire-and-forget (`tokio::spawn` equivalent — setImmediate)
 *
 * Every trait has an `enable(query)` gate consulted at runtime — the
 * orchestrator skips disabled components before executing them.
 */

/**
 * Minimal interface every query type must satisfy. Carries the feature-flag
 * decider so each stage can check `query.decider.isEnabled(flag)`.
 */
export interface PipelineQuery {
  /** Stable identifier of this query for logging / cache keying. */
  queryId: string;
  /** Optional feature-flag decider (see @ctx/services/pipelines). */
  decider?: unknown;
  /** Optional context for hierarchical provider resolution. */
  resolveContext?: {
    sessionId?: number;
    companySessionId?: number;
    templateId?: number;
  };
  /** Whether this query is being traced for debugging / counterfactual logs. */
  traceSampled?: boolean;
}

/** Every candidate type must have a stable identity. */
export interface PipelineCandidate {
  candidateId: string;
}

/**
 * Per-candidate result: either the (possibly mutated) candidate or an error
 * string. Mirrors the `Vec<Result<C, String>>` pattern from
 * `candidate-pipeline/scorer.rs` and `hydrator.rs`.
 */
export type CandidateResult<C extends PipelineCandidate> =
  | { ok: true; candidate: C }
  | { ok: false; candidateId: string; error: string };

/** Diagnostic envelope returned alongside selected candidates. */
export interface PipelineDiagnostics {
  /** Total wall-clock duration of this `execute()` call. */
  durationMs: number;
  /** Per-stage timing breakdown. */
  stages: StageDiagnostic[];
  /** Components that were skipped because `enable(query)` returned false. */
  skipped: string[];
  /** Per-candidate errors collected from all stages. */
  errors: Array<{ candidateId: string; stage: string; component: string; error: string }>;
}

export interface StageDiagnostic {
  stage: StageName;
  component: string;
  durationMs: number;
  candidatesIn?: number;
  candidatesOut?: number;
  cacheHits?: number;
  cacheMisses?: number;
  errors?: number;
}

export type StageName =
  | 'query_hydrator'
  | 'source'
  | 'hydrator'
  | 'filter'
  | 'scorer'
  | 'selector'
  | 'post_hydrator'
  | 'post_filter'
  | 'side_effect';

export interface PipelineResult<C extends PipelineCandidate> {
  /** Selected (final) candidates in order. */
  selected: C[];
  /** Candidates that were removed by filters, downscored, or not selected. */
  nonSelected: C[];
  /** Telemetry / debug payload. */
  diag: PipelineDiagnostics;
}

/** Filter output is partitioned into kept + removed for observability. */
export interface FilterResult<C extends PipelineCandidate> {
  kept: C[];
  removed: C[];
}

/** Selector output is partitioned into selected + non-selected. */
export interface SelectResult<C extends PipelineCandidate> {
  selected: C[];
  nonSelected: C[];
}

/** Side-effect input — the full picture after selection. */
export interface SideEffectInput<Q extends PipelineQuery, C extends PipelineCandidate> {
  query: Q;
  selectedCandidates: C[];
  nonSelectedCandidates: C[];
}
