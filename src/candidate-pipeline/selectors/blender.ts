/**
 * Blender selector — interleaves multiple candidate "tracks" with spacing
 * constraints.
 *
 * Inspired by `home-mixer/selectors/blender_selector.rs:24-75` and
 * `partition_organic_blender.rs:18-100`. Each track has its own scored
 * ordering; the blender takes the highest-scored item available subject to
 * spacing constraints — e.g. "no two items from track X within 3 slots".
 *
 * Typical use cases:
 *   - Multi-source feed where ads/promos need to be sparse among organic
 *   - Multi-agent output where you want round-robin between roles
 *   - Tool selection where you want at most 1 from each tool category at a time
 */
import type { Selector } from '../traits.js';
import type {
  PipelineCandidate,
  PipelineQuery,
  SelectResult,
} from '../types.js';

export interface BlenderTrack<C extends PipelineCandidate> {
  name: string;
  /** Items in this track in their preferred order. */
  items: C[];
  /** Min distance to the previous item from this track. Default 1 = no spacing. */
  minSpacing?: number;
  /** Hard cap on items from this track. Default Infinity. */
  cap?: number;
  /** Score of the *first* unconsumed item — used to break ties between tracks. */
  scoreOf?: (item: C) => number;
}

export interface BlenderSelectorOptions<C extends PipelineCandidate> {
  name?: string;
  totalK: number;
  tracks: ReadonlyArray<BlenderTrack<C>>;
  enable?: (query: unknown) => boolean;
}

interface TrackState<C extends PipelineCandidate> {
  track: BlenderTrack<C>;
  cursor: number;
  lastEmittedAt: number; // slot index of last item from this track; -Infinity initially
  emitted: number;
}

export class BlenderSelector<Q extends PipelineQuery, C extends PipelineCandidate>
  implements Selector<Q, C>
{
  readonly name: string;
  constructor(private opts: BlenderSelectorOptions<C>) {
    this.name = opts.name ?? 'blender';
  }
  enable(query: Q): boolean { return this.opts.enable ? this.opts.enable(query) : true; }
  size(): number { return this.opts.totalK; }
  /** Blender doesn't use a single score — return 0 as a sentinel. */
  score(_candidate: C): number { return 0; }

  select(_query: Q, _candidates: C[]): SelectResult<C> {
    const states: TrackState<C>[] = this.opts.tracks.map((t) => ({
      track: t,
      cursor: 0,
      lastEmittedAt: -Infinity,
      emitted: 0,
    }));

    const selected: C[] = [];
    const nonSelected: C[] = [];
    let slot = 0;

    while (selected.length < this.opts.totalK) {
      // Find the highest-scoring track whose next item respects spacing + cap.
      let bestState: TrackState<C> | null = null;
      let bestScore = -Infinity;
      for (const s of states) {
        if (s.cursor >= s.track.items.length) continue;
        if ((s.track.cap ?? Infinity) <= s.emitted) continue;
        const minSpacing = s.track.minSpacing ?? 1;
        if (slot - s.lastEmittedAt < minSpacing) continue;
        const item = s.track.items[s.cursor];
        const score = s.track.scoreOf ? s.track.scoreOf(item) : -s.cursor; // earlier = higher
        if (score > bestScore) {
          bestState = s;
          bestScore = score;
        }
      }
      if (!bestState) break; // no track can emit; we're done

      const item = bestState.track.items[bestState.cursor];
      selected.push(item);
      bestState.cursor++;
      bestState.emitted++;
      bestState.lastEmittedAt = slot;
      slot++;
    }

    // Collect non-selected = remaining items from every track.
    for (const s of states) {
      for (let i = s.cursor; i < s.track.items.length; i++) {
        nonSelected.push(s.track.items[i]);
      }
    }

    return { selected, nonSelected };
  }
}
