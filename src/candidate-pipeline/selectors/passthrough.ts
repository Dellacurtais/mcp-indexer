/**
 * Passthrough selector — keeps every candidate, in input order.
 *
 * Used by ingestion-style pipelines where the goal is to process all
 * surviving candidates (after filters) rather than pick a top-K. The
 * orchestrator still requires a `Selector` so we provide this trivial
 * implementation instead of forcing callers to use `TopKSelector` with
 * `k: Infinity`.
 */
import type { Selector } from '../traits.js';
import type {
  PipelineCandidate,
  PipelineQuery,
  SelectResult,
} from '../types.js';

export interface PassthroughSelectorOptions {
  /** Public name used in telemetry. */
  name?: string;
  /** Optional gate — defaults to always-on. */
  enable?: (query: unknown) => boolean;
}

export class PassthroughSelector<Q extends PipelineQuery, C extends PipelineCandidate>
  implements Selector<Q, C>
{
  readonly name: string;
  constructor(private opts: PassthroughSelectorOptions = {}) {
    this.name = opts.name ?? 'passthrough';
  }
  enable(query: Q): boolean {
    return this.opts.enable ? this.opts.enable(query) : true;
  }
  size(): number | undefined {
    return undefined;
  }
  score(_candidate: C): number {
    return 0;
  }
  select(_query: Q, candidates: C[]): SelectResult<C> {
    return { selected: candidates, nonSelected: [] };
  }
}
