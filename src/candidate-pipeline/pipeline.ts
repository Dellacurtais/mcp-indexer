/**
 * CandidatePipeline orchestrator — equivalent of the `execute()` flow in
 * `candidate-pipeline/candidate_pipeline.rs:89-137`.
 *
 * Execution order (each stage gated by `enable(query)`):
 *
 *   1. QueryHydrator*           — parallel; merge partials onto the query
 *   2. DependentQueryHydrator*  — parallel; second pass (e.g. fields that
 *                                 depend on first-pass results)
 *   3. Source*                  — parallel fan-out
 *   4. Hydrator*                — parallel enrichment
 *   5. Filter*                  — sequential; kept feeds next
 *   6. Scorer*                  — sequential async; order-preserving
 *   7. Selector                 — top-K
 *   8. PostSelectionHydrator*   — parallel; enrichment on the small set
 *   9. PostSelectionFilter*     — sequential; safety / visibility checks
 *  10. SideEffect*              — `setImmediate` (off the response path)
 *
 * Filter `removed` and Selector `nonSelected` candidates are passed to the
 * side effects (and accumulated in the diagnostic envelope) so observers
 * can see what was dropped and why.
 */
import type {
  QueryHydrator,
  Source,
  Hydrator,
  Filter,
  Scorer,
  Selector,
  SideEffect,
} from './traits.js';
import type {
  PipelineQuery,
  PipelineCandidate,
  PipelineResult,
  PipelineDiagnostics,
  CandidateResult,
  FilterResult,
  StageDiagnostic,
  StageName,
} from './types.js';
import {
  durationToBucket,
  eventToDiag,
  sizeToBucket,
  type TelemetryEvent,
  type TelemetrySink,
} from './stats.js';

export interface PipelineStages<Q extends PipelineQuery, C extends PipelineCandidate> {
  queryHydrators?: ReadonlyArray<QueryHydrator<Q>>;
  dependentQueryHydrators?: ReadonlyArray<QueryHydrator<Q>>;
  sources: ReadonlyArray<Source<Q, C>>;
  hydrators?: ReadonlyArray<Hydrator<Q, C>>;
  filters?: ReadonlyArray<Filter<Q, C>>;
  scorers?: ReadonlyArray<Scorer<Q, C>>;
  selector: Selector<Q, C>;
  postSelectionHydrators?: ReadonlyArray<Hydrator<Q, C>>;
  postSelectionFilters?: ReadonlyArray<Filter<Q, C>>;
  sideEffects?: ReadonlyArray<SideEffect<Q, C>>;
}

export interface CandidatePipelineConfig {
  /** Public name used as `pipeline_name` in telemetry. */
  name: string;
  /** Sink for stage-level traces. Optional — defaults to no-op. */
  telemetry?: TelemetrySink;
  /**
   * Cap on candidates after each stage; defaults to 10000. Defensive — if
   * a misbehaving source returns millions of candidates we trim early.
   */
  maxCandidates?: number;
}

const DEFAULT_MAX_CANDIDATES = 10000;

export class CandidatePipeline<Q extends PipelineQuery, C extends PipelineCandidate> {
  constructor(
    private cfg: CandidatePipelineConfig,
    private stages: PipelineStages<Q, C>,
  ) {}

  async execute(query: Q): Promise<PipelineResult<C>> {
    const start = performance.now();
    const stageDiags: StageDiagnostic[] = [];
    const skipped: string[] = [];
    const collectedErrors: PipelineDiagnostics['errors'] = [];
    const maxCandidates = this.cfg.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

    // 1+2. Query hydrators (two passes — first independent, then dependent).
    await this.runQueryHydrators(query, this.stages.queryHydrators, 'query_hydrator', stageDiags, skipped);
    await this.runQueryHydrators(query, this.stages.dependentQueryHydrators, 'query_hydrator', stageDiags, skipped);

    // 3. Sources — parallel fan-out.
    const sourceResults = await this.runSources(query, stageDiags, skipped, collectedErrors);
    let candidates: C[] = [];
    for (const arr of sourceResults) candidates.push(...arr);
    if (candidates.length > maxCandidates) {
      candidates = candidates.slice(0, maxCandidates);
    }

    // 4. Hydrators — parallel enrichment.
    candidates = await this.runHydrators(query, candidates, 'hydrator', this.stages.hydrators, stageDiags, skipped, collectedErrors);

    // 5. Filters — sequential.
    const removedAll: C[] = [];
    candidates = await this.runFilters(query, candidates, 'filter', this.stages.filters, stageDiags, skipped, removedAll);

    // 6. Scorers — sequential async.
    candidates = await this.runScorers(query, candidates, stageDiags, skipped, collectedErrors);

    // 7. Selector.
    const selectorResult = await this.runSelector(query, candidates, stageDiags, skipped);
    let { selected } = selectorResult;
    const { nonSelected } = selectorResult;

    // 8. Post-selection hydrators (on the small set).
    selected = await this.runHydrators(query, selected, 'post_hydrator', this.stages.postSelectionHydrators, stageDiags, skipped, collectedErrors);

    // 9. Post-selection filters.
    const postRemoved: C[] = [];
    selected = await this.runFilters(query, selected, 'post_filter', this.stages.postSelectionFilters, stageDiags, skipped, postRemoved);

    // 10. Side effects — fire-and-forget after the response is computed.
    this.runSideEffectsBackground(query, selected, [...nonSelected, ...removedAll, ...postRemoved]);

    const diag: PipelineDiagnostics = {
      durationMs: performance.now() - start,
      stages: stageDiags,
      skipped,
      errors: collectedErrors,
    };

    return {
      selected,
      nonSelected: [...nonSelected, ...removedAll, ...postRemoved],
      diag,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // QueryHydrators (parallel)
  // ────────────────────────────────────────────────────────────────────
  private async runQueryHydrators(
    query: Q,
    hydrators: ReadonlyArray<QueryHydrator<Q>> | undefined,
    stage: StageName,
    diags: StageDiagnostic[],
    skipped: string[],
  ): Promise<void> {
    if (!hydrators || hydrators.length === 0) return;
    const active = hydrators.filter((h) => h.enable(query));
    for (const h of hydrators) if (!active.includes(h)) skipped.push(`${stage}/${h.name}`);
    const results = await Promise.allSettled(
      active.map(async (h) => {
        const t0 = performance.now();
        const partial = await h.hydrate(query);
        h.update(query, partial);
        this.emit({
          pipelineName: this.cfg.name,
          stage,
          component: h.name,
          durationMs: performance.now() - t0,
          durationBucket: durationToBucket(performance.now() - t0),
          traceSampled: query.traceSampled,
        }, diags);
      }),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        // Failures in query hydrators are non-fatal — emit diagnostic only.
        diags.push({ stage, component: 'rejected', durationMs: 0, errors: 1 });
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Sources (parallel)
  // ────────────────────────────────────────────────────────────────────
  private async runSources(
    query: Q,
    diags: StageDiagnostic[],
    skipped: string[],
    errs: PipelineDiagnostics['errors'],
  ): Promise<C[][]> {
    const active = this.stages.sources.filter((s) => s.enable(query));
    for (const s of this.stages.sources) if (!active.includes(s)) skipped.push(`source/${s.name}`);
    const results = await Promise.allSettled(
      active.map(async (s) => {
        const t0 = performance.now();
        try {
          const candidates = await s.source(query);
          this.emit({
            pipelineName: this.cfg.name,
            stage: 'source',
            component: s.name,
            durationMs: performance.now() - t0,
            durationBucket: durationToBucket(performance.now() - t0),
            candidatesOut: candidates.length,
            sizeBucket: sizeToBucket(candidates.length),
            traceSampled: query.traceSampled,
          }, diags);
          return candidates;
        } catch (e) {
          errs.push({ candidateId: '*', stage: 'source', component: s.name, error: (e as Error).message });
          this.emit({
            pipelineName: this.cfg.name,
            stage: 'source',
            component: s.name,
            durationMs: performance.now() - t0,
            durationBucket: durationToBucket(performance.now() - t0),
            candidatesOut: 0,
            errors: 1,
            traceSampled: query.traceSampled,
          }, diags);
          return [];
        }
      }),
    );
    return results.map((r) => (r.status === 'fulfilled' ? r.value : []));
  }

  // ────────────────────────────────────────────────────────────────────
  // Hydrators (parallel, order-preserving)
  // ────────────────────────────────────────────────────────────────────
  private async runHydrators(
    query: Q,
    candidates: C[],
    stage: StageName,
    hydrators: ReadonlyArray<Hydrator<Q, C>> | undefined,
    diags: StageDiagnostic[],
    skipped: string[],
    errs: PipelineDiagnostics['errors'],
  ): Promise<C[]> {
    if (!hydrators || hydrators.length === 0 || candidates.length === 0) return candidates;
    const active = hydrators.filter((h) => h.enable(query));
    for (const h of hydrators) if (!active.includes(h)) skipped.push(`${stage}/${h.name}`);
    if (active.length === 0) return candidates;

    const results = await Promise.allSettled(
      active.map(async (h) => {
        const t0 = performance.now();
        const out = await h.hydrate(query, candidates);
        return { h, out, durationMs: performance.now() - t0 };
      }),
    );

    for (const r of results) {
      if (r.status !== 'fulfilled') {
        diags.push({ stage, component: 'rejected', durationMs: 0, errors: 1 });
        continue;
      }
      const { h, out, durationMs } = r.value;
      if (out.length !== candidates.length) {
        // Invariant violation — log and skip applying.
        diags.push({ stage, component: h.name, durationMs, errors: candidates.length });
        continue;
      }
      let errCount = 0;
      for (let i = 0; i < out.length; i++) {
        const item = out[i];
        if (item.ok) {
          h.update(candidates[i], item.candidate);
        } else {
          errs.push({ candidateId: item.candidateId, stage, component: h.name, error: item.error });
          errCount++;
        }
      }
      this.emit({
        pipelineName: this.cfg.name,
        stage,
        component: h.name,
        durationMs,
        durationBucket: durationToBucket(durationMs),
        candidatesIn: candidates.length,
        candidatesOut: candidates.length,
        sizeBucket: sizeToBucket(candidates.length),
        errors: errCount,
        traceSampled: query.traceSampled,
      }, diags);
    }
    return candidates;
  }

  // ────────────────────────────────────────────────────────────────────
  // Filters (sequential)
  // ────────────────────────────────────────────────────────────────────
  private async runFilters(
    query: Q,
    candidates: C[],
    stage: StageName,
    filters: ReadonlyArray<Filter<Q, C>> | undefined,
    diags: StageDiagnostic[],
    skipped: string[],
    removedAccum: C[],
  ): Promise<C[]> {
    if (!filters || filters.length === 0) return candidates;
    let current = candidates;
    for (const f of filters) {
      if (!f.enable(query)) { skipped.push(`${stage}/${f.name}`); continue; }
      const t0 = performance.now();
      let result: FilterResult<C>;
      try {
        result = await f.filter(query, current);
      } catch {
        diags.push({ stage, component: f.name, durationMs: performance.now() - t0, errors: current.length });
        continue;
      }
      removedAccum.push(...result.removed);
      this.emit({
        pipelineName: this.cfg.name,
        stage,
        component: f.name,
        durationMs: performance.now() - t0,
        durationBucket: durationToBucket(performance.now() - t0),
        candidatesIn: current.length,
        candidatesOut: result.kept.length,
        sizeBucket: sizeToBucket(result.kept.length),
        traceSampled: query.traceSampled,
      }, diags);
      current = result.kept;
    }
    return current;
  }

  // ────────────────────────────────────────────────────────────────────
  // Scorers (sequential async, order-preserving)
  // ────────────────────────────────────────────────────────────────────
  private async runScorers(
    query: Q,
    candidates: C[],
    diags: StageDiagnostic[],
    skipped: string[],
    errs: PipelineDiagnostics['errors'],
  ): Promise<C[]> {
    const scorers = this.stages.scorers;
    if (!scorers || scorers.length === 0 || candidates.length === 0) return candidates;
    for (const s of scorers) {
      if (!s.enable(query)) { skipped.push(`scorer/${s.name}`); continue; }
      const t0 = performance.now();
      let out: Array<CandidateResult<C>>;
      try {
        out = await s.score(query, candidates);
      } catch (e) {
        errs.push({ candidateId: '*', stage: 'scorer', component: s.name, error: (e as Error).message });
        diags.push({ stage: 'scorer', component: s.name, durationMs: performance.now() - t0, errors: candidates.length });
        continue;
      }
      if (out.length !== candidates.length) {
        diags.push({ stage: 'scorer', component: s.name, durationMs: performance.now() - t0, errors: candidates.length });
        continue;
      }
      let errCount = 0;
      for (let i = 0; i < out.length; i++) {
        const item = out[i];
        if (item.ok) {
          s.update(candidates[i], item.candidate);
        } else {
          errs.push({ candidateId: item.candidateId, stage: 'scorer', component: s.name, error: item.error });
          errCount++;
        }
      }
      this.emit({
        pipelineName: this.cfg.name,
        stage: 'scorer',
        component: s.name,
        durationMs: performance.now() - t0,
        durationBucket: durationToBucket(performance.now() - t0),
        candidatesIn: candidates.length,
        candidatesOut: candidates.length,
        sizeBucket: sizeToBucket(candidates.length),
        errors: errCount,
        traceSampled: query.traceSampled,
      }, diags);
    }
    return candidates;
  }

  // ────────────────────────────────────────────────────────────────────
  // Selector
  // ────────────────────────────────────────────────────────────────────
  private async runSelector(
    query: Q,
    candidates: C[],
    diags: StageDiagnostic[],
    skipped: string[],
  ): Promise<{ selected: C[]; nonSelected: C[] }> {
    const sel = this.stages.selector;
    if (!sel.enable(query)) {
      skipped.push(`selector/${sel.name}`);
      return { selected: candidates, nonSelected: [] };
    }
    const t0 = performance.now();
    const result = sel.select(query, candidates);
    this.emit({
      pipelineName: this.cfg.name,
      stage: 'selector',
      component: sel.name,
      durationMs: performance.now() - t0,
      durationBucket: durationToBucket(performance.now() - t0),
      candidatesIn: candidates.length,
      candidatesOut: result.selected.length,
      sizeBucket: sizeToBucket(result.selected.length),
      traceSampled: query.traceSampled,
    }, diags);
    return result;
  }

  // ────────────────────────────────────────────────────────────────────
  // SideEffects (fire-and-forget)
  // ────────────────────────────────────────────────────────────────────
  private runSideEffectsBackground(query: Q, selected: C[], nonSelected: C[]): void {
    const sinks = this.stages.sideEffects;
    if (!sinks || sinks.length === 0) return;
    const active = sinks.filter((s) => s.enable(query));
    if (active.length === 0) return;
    const input = { query, selectedCandidates: selected, nonSelectedCandidates: nonSelected };
    // schedule outside the current microtask to avoid delaying caller
    setImmediate(() => {
      for (const s of active) {
        const t0 = performance.now();
        s.sideEffect(input)
          .then(() => {
            this.emit({
              pipelineName: this.cfg.name,
              stage: 'side_effect',
              component: s.name,
              durationMs: performance.now() - t0,
              durationBucket: durationToBucket(performance.now() - t0),
              traceSampled: query.traceSampled,
            });
          })
          .catch(() => {
            this.emit({
              pipelineName: this.cfg.name,
              stage: 'side_effect',
              component: s.name,
              durationMs: performance.now() - t0,
              durationBucket: durationToBucket(performance.now() - t0),
              errors: 1,
              traceSampled: query.traceSampled,
            });
          });
      }
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Telemetry emit helper
  // ────────────────────────────────────────────────────────────────────
  private emit(event: TelemetryEvent, diags?: StageDiagnostic[]): void {
    if (diags) diags.push(eventToDiag(event));
    try { this.cfg.telemetry?.emit(event); } catch { /* never throw from telemetry */ }
  }
}
