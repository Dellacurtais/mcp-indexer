/**
 * Diversity-aware selector — attenuates the score of repeated authors/groups
 * to ensure variety in the top-K.
 *
 * Inspired by the "author diversity scorer" described in the x-algorithm
 * README. Implementation: each subsequent candidate from the same group has
 * its score multiplied by `attenuation^k` where k is its position within the
 * group (1st = 1.0, 2nd = `attenuation`, 3rd = `attenuation^2`, …).
 *
 * Use this when you have an obvious grouping key (author id, role name,
 * file directory, etc.) and want to prevent any one group from dominating
 * the result. With `attenuation = 0.5`, the 2nd of a group needs to score
 * 2× higher than the 1st of an unrelated group to outrank it.
 */
import type { Selector } from '../traits.js';
import type {
  PipelineCandidate,
  PipelineQuery,
  SelectResult,
} from '../types.js';

export interface DiversitySelectorOptions<C extends PipelineCandidate> {
  name?: string;
  k: number;
  scoreOf: (candidate: C) => number;
  groupKey: (candidate: C) => string;
  /** Per-repeat attenuation factor in (0, 1]. Default 0.5. */
  attenuation?: number;
  enable?: (query: unknown) => boolean;
}

export class DiversitySelector<Q extends PipelineQuery, C extends PipelineCandidate>
  implements Selector<Q, C>
{
  readonly name: string;
  constructor(private opts: DiversitySelectorOptions<C>) {
    this.name = opts.name ?? 'diversity';
  }
  enable(query: Q): boolean { return this.opts.enable ? this.opts.enable(query) : true; }
  size(): number { return this.opts.k; }
  score(candidate: C): number { return this.opts.scoreOf(candidate); }

  select(_query: Q, candidates: C[]): SelectResult<C> {
    const attenuation = this.opts.attenuation ?? 0.5;
    // Greedy: pick the highest currently-attenuated candidate, mark its group,
    // and repeat. This is O(n²) in the worst case but n is typically small
    // (top-K selectors operate on < 1000 candidates).
    const remaining = [...candidates];
    const selected: C[] = [];
    const groupCount = new Map<string, number>();

    while (remaining.length > 0 && selected.length < this.opts.k) {
      let bestIdx = -1;
      let bestScore = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const c = remaining[i];
        const g = this.opts.groupKey(c);
        const k = groupCount.get(g) ?? 0;
        const attenuated = this.opts.scoreOf(c) * Math.pow(attenuation, k);
        if (attenuated > bestScore) {
          bestScore = attenuated;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      const chosen = remaining[bestIdx];
      selected.push(chosen);
      remaining.splice(bestIdx, 1);
      const g = this.opts.groupKey(chosen);
      groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
    }

    return { selected, nonSelected: remaining };
  }
}
