/**
 * Stats infrastructure for the candidate-pipeline framework.
 *
 * Mirrors the bucketed histogram convention from
 * `candidate-pipeline/*.rs` via `#[xai_stats_macro::receive_stats(...)]`:
 *
 *   - Duration buckets: 0-10ms / 0-50ms / 50-500ms / 500-2500ms / 2500ms+
 *   - Size buckets:     0-10 / 0-50 / 50-500 / 500-1000 / 1000-2500 / 2500+
 *
 * The orchestrator emits one row per stage execution via a `TelemetrySink`.
 * Sinks live in `apps/http-api` (DB-backed) or in tests (in-memory).
 */
import type { StageDiagnostic, StageName } from './types.js';

export type DurationBucket =
  | '0-10ms'
  | '0-50ms'
  | '50-500ms'
  | '500-2500ms'
  | '2500ms+';

export type SizeBucket =
  | '0-10'
  | '0-50'
  | '50-500'
  | '500-1000'
  | '1000-2500'
  | '2500+';

export function durationToBucket(ms: number): DurationBucket {
  if (ms < 10) return '0-10ms';
  if (ms < 50) return '0-50ms';
  if (ms < 500) return '50-500ms';
  if (ms < 2500) return '500-2500ms';
  return '2500ms+';
}

export function sizeToBucket(n: number): SizeBucket {
  if (n < 10) return '0-10';
  if (n < 50) return '0-50';
  if (n < 500) return '50-500';
  if (n < 1000) return '500-1000';
  if (n < 2500) return '1000-2500';
  return '2500+';
}

export interface TelemetryEvent {
  pipelineName: string;
  stage: StageName;
  component: string;
  durationMs: number;
  durationBucket: DurationBucket;
  candidatesIn?: number;
  candidatesOut?: number;
  sizeBucket?: SizeBucket;
  cacheHits?: number;
  cacheMisses?: number;
  errors?: number;
  diag?: Record<string, unknown>;
  traceSampled?: boolean;
  sessionId?: number;
  companySessionId?: number;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
  /** Flush any buffered rows. Called periodically by the orchestrator host. */
  flush?(): Promise<void> | void;
}

/** In-memory sink used by TESTS. NOT for production — `events` grows
 *  unbounded, so a long-running host must use {@link NoopTelemetrySink}. */
export class InMemoryTelemetrySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  emit(event: TelemetryEvent): void { this.events.push(event); }
  clear(): void { this.events.length = 0; }
}

/** True no-op sink — drops every event. Use this to disable pipeline
 *  telemetry persistence on a long-running server without leaking memory. */
export class NoopTelemetrySink implements TelemetrySink {
  emit(_event: TelemetryEvent): void { /* intentionally discarded */ }
}

/**
 * Composite sink — emits to all attached sinks. Useful when the host wants
 * both a DB-backed sink and a Prometheus-style sink simultaneously.
 */
export class CompositeTelemetrySink implements TelemetrySink {
  constructor(private sinks: TelemetrySink[]) {}
  emit(event: TelemetryEvent): void {
    for (const s of this.sinks) {
      try { s.emit(event); } catch { /* swallow; one bad sink shouldn't break others */ }
    }
  }
  async flush(): Promise<void> {
    for (const s of this.sinks) {
      if (s.flush) await s.flush();
    }
  }
}

/**
 * Measure the duration of an async block and return both the value and the
 * event metadata. Helper used by the orchestrator — application code
 * doesn't call this directly.
 */
export async function measure<T>(
  body: () => Promise<T>,
): Promise<{ value: T; durationMs: number }> {
  const start = performance.now();
  const value = await body();
  return { value, durationMs: performance.now() - start };
}

/** Convert a `TelemetryEvent` into a `StageDiagnostic` for inline reporting. */
export function eventToDiag(event: TelemetryEvent): StageDiagnostic {
  return {
    stage: event.stage,
    component: event.component,
    durationMs: event.durationMs,
    candidatesIn: event.candidatesIn,
    candidatesOut: event.candidatesOut,
    cacheHits: event.cacheHits,
    cacheMisses: event.cacheMisses,
    errors: event.errors,
  };
}
