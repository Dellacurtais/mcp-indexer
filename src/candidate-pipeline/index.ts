/**
 * Public API of `@ctx/candidate-pipeline`.
 *
 * Pattern: re-export everything callers need to BUILD a pipeline, plus the
 * orchestrator itself. Each consumer composes its own `PipelineStages<Q, C>`
 * and creates a `CandidatePipeline` instance.
 */

// Core types
export type {
  PipelineQuery,
  PipelineCandidate,
  CandidateResult,
  PipelineResult,
  PipelineDiagnostics,
  FilterResult,
  SelectResult,
  SideEffectInput,
  StageDiagnostic,
  StageName,
} from './types.js';

// Traits
export type {
  QueryHydrator,
  Source,
  Hydrator,
  CachedHydrator,
  CacheStore,
  Filter,
  Scorer,
  Selector,
  SideEffect,
} from './traits.js';

// Orchestrator
export { CandidatePipeline } from './pipeline.js';
export type { PipelineStages, CandidatePipelineConfig } from './pipeline.js';

// Stats
export {
  durationToBucket,
  sizeToBucket,
  InMemoryTelemetrySink,
  NoopTelemetrySink,
  CompositeTelemetrySink,
  measure,
} from './stats.js';
export type { DurationBucket, SizeBucket, TelemetrySink, TelemetryEvent } from './stats.js';

// Scorers (helpers)
export { rrfMerge, RRF_DEFAULT_K } from './scorers/rrf.js';
export type { Rankable, RankedSource, RrfMergeOptions } from './scorers/rrf.js';

export {
  DEFAULT_NUM_HYPERPLANES,
  DEFAULT_NUM_HASHES,
  DEFAULT_NUM_BUCKETS,
  mulberry32,
  generateHyperplanes,
  simHashSignature,
  hammingDistance,
  estimateCosineFromHamming,
  generateMultiHashParams,
  bucketize,
  computeLshEntry,
} from './scorers/lsh.js';
export type { MultiHashParams, LshIndexEntry } from './scorers/lsh.js';

export { weightedSum } from './scorers/weighted-sum.js';
export type { WeightedSumSignal, WeightedSumOptions, WeightedSumResult } from './scorers/weighted-sum.js';

export {
  l2Normalize,
  l2NormalizeInPlace,
  dot,
  cosineSimilarity,
  cosineSimilarities,
} from './scorers/two-tower.js';

export { recencyDecay, batchRecencyDecay } from './scorers/recency-decay.js';
export type { RecencyDecayOptions } from './scorers/recency-decay.js';

export { frequencyBoost, batchFrequencyBoost } from './scorers/frequency-boost.js';
export type { FrequencyBoostOptions } from './scorers/frequency-boost.js';

export { withCandidateIsolationCache } from './scorers/candidate-isolation.js';
export type { IsolatedScoreInput, IsolatedScoreCacheOptions } from './scorers/candidate-isolation.js';

// Selectors
export { TopKSelector } from './selectors/top-k.js';
export type { TopKSelectorOptions } from './selectors/top-k.js';

export { DiversitySelector } from './selectors/diversity.js';
export type { DiversitySelectorOptions } from './selectors/diversity.js';

export { BlenderSelector } from './selectors/blender.js';
export type { BlenderSelectorOptions, BlenderTrack } from './selectors/blender.js';

export { PassthroughSelector } from './selectors/passthrough.js';
export type { PassthroughSelectorOptions } from './selectors/passthrough.js';

// Cache utilities
export { LruCache } from './cache/lru.js';
export type { LruCacheOptions } from './cache/lru.js';

export { runCachedHydrator } from './cache/cached-hydrator-runner.js';
export type { CacheHydrationStats } from './cache/cached-hydrator-runner.js';

// SQLite telemetry sink (./sqlite-sink) intentionally dropped — the code-context
// POC passes no telemetry sink (the indexer's pipelineTelemetry arg stays undefined),
// so this optional store-coupled export is omitted.
