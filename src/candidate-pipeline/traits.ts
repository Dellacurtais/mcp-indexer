/**
 * 8 traits of the candidate-pipeline framework — TypeScript translation of
 * the Rust traits in `xai-org/x-algorithm/candidate-pipeline/*.rs`.
 *
 * Invariants enforced by the orchestrator:
 *   - `enable(query)` is consulted before each invocation; skipped components
 *     don't run and don't emit telemetry.
 *   - Hydrators / Scorers / PostHydrators MUST return arrays the same length
 *     as the input, in the same order. The orchestrator zips them back onto
 *     the in-place candidate set.
 *   - Filters return `{ kept, removed }`; `removed` is tracked for
 *     observability, not silently dropped.
 *   - SideEffects fire after the response is built (`setImmediate`); their
 *     failures never affect the returned `PipelineResult`.
 */

import type {
  PipelineQuery,
  PipelineCandidate,
  CandidateResult,
  FilterResult,
  SelectResult,
  SideEffectInput,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// QueryHydrator — runs in parallel BEFORE any candidate work.
//
// Translated from `candidate-pipeline/query_hydrator.rs:8-41`.
// ─────────────────────────────────────────────────────────────────────────
export interface QueryHydrator<Q extends PipelineQuery> {
  readonly name: string;
  enable(query: Q): boolean;
  /**
   * Return a partial query object whose fields will be merged into the
   * original query via `update(...)`. May throw — failures are logged but
   * non-fatal.
   */
  hydrate(query: Q): Promise<Partial<Q>>;
  /** Merge the partial back into the live query in place. */
  update(query: Q, hydrated: Partial<Q>): void;
}

// ─────────────────────────────────────────────────────────────────────────
// Source — produces candidates. Multiple sources fan out in parallel.
//
// Translated from `candidate-pipeline/source.rs:8-39`.
// ─────────────────────────────────────────────────────────────────────────
export interface Source<Q extends PipelineQuery, C extends PipelineCandidate> {
  readonly name: string;
  enable(query: Q): boolean;
  /** Produce a candidate list for this source. Errors halt this source only. */
  source(query: Q): Promise<C[]>;
}

// ─────────────────────────────────────────────────────────────────────────
// Hydrator — enriches candidates in parallel.
//
// Translated from `candidate-pipeline/hydrator.rs:11-67`.
// MUST return same-length array in same order.
// ─────────────────────────────────────────────────────────────────────────
export interface Hydrator<Q extends PipelineQuery, C extends PipelineCandidate> {
  readonly name: string;
  enable(query: Q): boolean;
  hydrate(query: Q, candidates: readonly C[]): Promise<Array<CandidateResult<C>>>;
  /** Merge a hydrated copy of `candidate` back onto the in-place candidate. */
  update(candidate: C, hydrated: C): void;
}

// ─────────────────────────────────────────────────────────────────────────
// CachedHydrator — Hydrator + automatic cache-hit/miss routing.
//
// Translated from `candidate-pipeline/hydrator.rs:79-184`.
// Backed by a `CacheStore<K, V>` (see ./cache/cache-store.ts).
// ─────────────────────────────────────────────────────────────────────────
export interface CachedHydrator<Q extends PipelineQuery, C extends PipelineCandidate, K, V>
  extends Hydrator<Q, C> {
  cacheStore: CacheStore<K, V>;
  cacheKey(candidate: C): K;
  cacheValue(hydrated: C): V;
  hydrateFromCache(value: V): C;
  hydrateFromClient(query: Q, candidates: readonly C[]): Promise<Array<CandidateResult<C>>>;
}

export interface CacheStore<K, V> {
  get(key: K): V | undefined | Promise<V | undefined>;
  set(key: K, value: V, ttlMs?: number): void | Promise<void>;
  delete(key: K): void | Promise<void>;
  clear(): void | Promise<void>;
  /** Number of currently cached entries. */
  size(): number;
}

// ─────────────────────────────────────────────────────────────────────────
// Filter — partitions candidates into kept / removed.
//
// Translated from `candidate-pipeline/filter.rs:16-70`.
// Filters run sequentially: each filter sees only the kept set of the
// previous one.
// ─────────────────────────────────────────────────────────────────────────
export interface Filter<Q extends PipelineQuery, C extends PipelineCandidate> {
  readonly name: string;
  enable(query: Q): boolean;
  filter(query: Q, candidates: C[]): FilterResult<C> | Promise<FilterResult<C>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Scorer — assigns a numeric score to each candidate.
//
// Translated from `candidate-pipeline/scorer.rs:8-65`.
// Scorers run sequentially; each scorer accumulates its own fields onto the
// in-place candidate via `update(...)`. MUST preserve order.
// ─────────────────────────────────────────────────────────────────────────
export interface Scorer<Q extends PipelineQuery, C extends PipelineCandidate> {
  readonly name: string;
  enable(query: Q): boolean;
  score(query: Q, candidates: readonly C[]): Promise<Array<CandidateResult<C>>>;
  /** Merge a scored copy back onto the in-place candidate. */
  update(candidate: C, scored: C): void;
}

// ─────────────────────────────────────────────────────────────────────────
// Selector — picks the final top-K.
//
// Translated from `candidate-pipeline/selector.rs:21-85`.
// Default behavior: sort by `score(c)` descending, truncate to `size()`.
// Custom selectors (Blender / Diversity) override `select(...)` directly.
// ─────────────────────────────────────────────────────────────────────────
export interface Selector<Q extends PipelineQuery, C extends PipelineCandidate> {
  readonly name: string;
  enable(query: Q): boolean;
  /** Optional size cap. Undefined → keep all candidates. */
  size(): number | undefined;
  /** Used by the default sort path. Custom selectors can ignore. */
  score(candidate: C): number;
  /** Full control over selection. Default implementation sorts by `score`. */
  select(query: Q, candidates: C[]): SelectResult<C>;
}

// ─────────────────────────────────────────────────────────────────────────
// SideEffect — runs AFTER the response is built. Fire-and-forget.
//
// Translated from `candidate-pipeline/side_effect.rs:16-37`.
// ─────────────────────────────────────────────────────────────────────────
export interface SideEffect<Q extends PipelineQuery, C extends PipelineCandidate> {
  readonly name: string;
  enable(query: Q): boolean;
  sideEffect(input: SideEffectInput<Q, C>): Promise<void>;
}
