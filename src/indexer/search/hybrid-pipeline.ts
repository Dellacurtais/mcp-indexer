/**
 * I1 — HybridSearchPipeline: `HybridSearch.search()` rebuilt on the
 * `@ctx/candidate-pipeline` framework.
 *
 * **Goal**: same recall/MRR/latency as the legacy method, but with the
 * framework's per-stage telemetry, A/B shadow infrastructure, and
 * Decider gating wired in. The migration is the architectural payoff
 * of the entire x-algorithm exploration.
 *
 * **Default OFF**: the existing `HybridSearch.search()` calls this
 * pipeline ONLY when `MCP_PIPELINES_INDEXER_SEARCH_V2=1`. Without the
 * flag, the legacy code path runs unchanged — bit-identical to pre-I1.
 *
 * **Stage map**:
 *
 *   Source        ── FtsSource         (FTS5 — sb_symbols + files)
 *                 ── VectorSource      (vector + HyDE variants + RRF across them)
 *                 ── RecentFilesSource (when MCP_PIPELINES_RECENT_FILES_SOURCE=1)
 *
 *   Scorer        ── RrfFusionScorer   (canonical K=60 across all sources)
 *
 *   Selector      ── TopKSelector
 *
 *   PostSelHydr.  ── RerankerHydrator  (cross-encoder on top-K)
 *
 *   SideEffect    ── CacheWriteSink    (populates the LRU cache for next call)
 *                 ── TelemetryEmitSink (via the CandidatePipeline's built-in
 *                                       per-stage emit — automatic when
 *                                       `telemetry` is wired)
 *
 * **RRF parity**: each Source records the candidate's rank in its own
 * output list. The RrfFusionScorer reads those ranks and applies
 * `1 / (K + rank + 1)` with K=60 — identical to the legacy `cpRrfMerge`
 * formula in `@ctx/candidate-pipeline/scorers/rrf`. The parity test
 * (`__tests__/hybrid-pipeline-parity.test.ts`) asserts the new path
 * produces the same ordering as the legacy method on a fixed corpus.
 */
import {
  CandidatePipeline,
  TopKSelector,
  type Filter,
  type Hydrator,
  type PipelineCandidate,
  type PipelineQuery,
  type Scorer,
  type SideEffect,
  type Source,
  type TelemetrySink,
} from '@ctx/candidate-pipeline';
import { rrfMerge as cpRrfMerge, RRF_DEFAULT_K } from '@ctx/candidate-pipeline/scorers/rrf.js';
import { codeNamespace } from '@ctx/shared/vector-namespace.js';
import type { CodeIndexDB } from '@ctx/store/db.js';
import type { VectorStore } from '@ctx/store/vectors.js';
import type { EmbeddingService } from '@ctx/indexer/search/embeddings.js';
import { NullEmbeddingService } from '@ctx/indexer/search/embeddings.js';
import type { HyDEService } from '@ctx/indexer/search/hyde.js';
import { planQuery } from '@ctx/indexer/search/planner.js';
import type { RerankerService } from '@ctx/indexer/search/reranker.js';
import { NullReranker } from '@ctx/indexer/search/reranker.js';
import type { RecentFilesSource } from '@ctx/indexer/search/recent-files-source.js';
import type {
  ContextSnapshot,
  DBFile,
  DBSymbol,
  HybridSearchResult,
  SearchType,
} from '@ctx/shared/types.js';

const RRF_K = RRF_DEFAULT_K; // 60

// ─── Query and Candidate types ────────────────────────────────────────

export interface HybridSearchPipelineQuery extends PipelineQuery {
  projectId: number;
  projectName: string;
  query: string;
  type: SearchType;
  /** Over-fetch factor — each source fetches `limit * 3` to feed the RRF. */
  overFetch: number;
  /** Final result count to return after selection + reranking. */
  limit: number;
  /**
   * Diagnostic accumulator. Each stage may append/overwrite fields
   * here for downstream observers. The wrapping `HybridSearch.search()`
   * reads this back to build the user-facing `SearchDiagnostics`.
   */
  diag: {
    ftsCount?: number;
    vectorRawMatches?: number;
    vectorRehydrated?: number;
    vectorError?: string;
    queryVariants?: string[];
    recentFilesCount?: number;
  };
}

export interface HybridSearchPipelineCandidate extends PipelineCandidate {
  /** The hybrid result row eventually returned to the caller. */
  result: HybridSearchResult;
  /** Per-source rank — set by each source for its own emissions. */
  ranks: {
    fts?: number; // 1-indexed
    vector?: number; // 1-indexed
    recent?: number; // 1-indexed
  };
  /** Final RRF score. Set by RrfFusionScorer. */
  score: number;
}

// ─── Helper: build candidate identity ─────────────────────────────────

function candidateKey(r: HybridSearchResult): string {
  return `${r.type}:${r.id}`;
}

function emptyCandidate(r: HybridSearchResult): HybridSearchPipelineCandidate {
  return {
    candidateId: candidateKey(r),
    result: r,
    ranks: {},
    score: 0,
  };
}

// ─── Sources ──────────────────────────────────────────────────────────

interface RawSearchInputs {
  db: CodeIndexDB;
  vectorStore: VectorStore | null;
  embeddingService: EmbeddingService;
  hyde: HyDEService | null;
  recentFilesSource: RecentFilesSource | null;
  /**
   * Reuse the legacy method's FTS sanitization to keep parity. Takes a
   * boolean connector so the source can run AND-first (precision) then fall
   * back to OR (recall) — mirroring `HybridSearch.ftsSearch`.
   */
  ftsSanitize: (q: string, connector: 'AND' | 'OR') => string;
}

export class FtsSource implements Source<HybridSearchPipelineQuery, HybridSearchPipelineCandidate> {
  readonly name = 'fts';
  constructor(private deps: RawSearchInputs) {}

  enable(): boolean {
    return true;
  }

  async source(q: HybridSearchPipelineQuery): Promise<HybridSearchPipelineCandidate[]> {
    // Precision-first (AND); widen to OR only when AND finds nothing — mirrors
    // HybridSearch.ftsSearch so the V2 path stays consistent with legacy.
    const andQuery = this.deps.ftsSanitize(q.query, 'AND');
    let results = this.runFts(q, andQuery);
    if (results.length === 0) {
      const orQuery = this.deps.ftsSanitize(q.query, 'OR');
      if (orQuery !== andQuery) results = this.runFts(q, orQuery);
    }
    q.diag.ftsCount = results.length;
    return results;
  }

  private runFts(q: HybridSearchPipelineQuery, ftsQuery: string): HybridSearchPipelineCandidate[] {
    const results: HybridSearchPipelineCandidate[] = [];
    if (ftsQuery.length === 0) return results;

    if (q.type === 'files' || q.type === 'all') {
      const files = this.deps.db.searchFiles(q.projectId, ftsQuery, q.overFetch);
      for (let i = 0; i < files.length; i++) {
        const r: HybridSearchResult = {
          id: files[i].id,
          type: 'file',
          score: 0,
          fts_rank: i + 1,
          vector_score: null,
          data: files[i],
        };
        const c = emptyCandidate(r);
        c.ranks.fts = i + 1;
        results.push(c);
      }
    }
    if (q.type === 'symbols' || q.type === 'all') {
      const symbols = this.deps.db.searchSymbols(q.projectId, ftsQuery, q.overFetch);
      for (let i = 0; i < symbols.length; i++) {
        const r: HybridSearchResult = {
          id: symbols[i].id,
          type: 'symbol',
          score: 0,
          fts_rank: i + 1,
          vector_score: null,
          data: symbols[i],
        };
        const c = emptyCandidate(r);
        c.ranks.fts = i + 1;
        results.push(c);
      }
    }
    return results;
  }
}

export class VectorSource implements Source<HybridSearchPipelineQuery, HybridSearchPipelineCandidate> {
  readonly name = 'vector';
  constructor(private deps: RawSearchInputs) {}

  enable(q: HybridSearchPipelineQuery): boolean {
    // Skip vector when embeddings/vector store missing — degrade gracefully
    // to FTS-only. Mirrors the legacy `vectorSearchExpanded` early return.
    return !!this.deps.vectorStore && !(this.deps.embeddingService instanceof NullEmbeddingService);
  }

  async source(q: HybridSearchPipelineQuery): Promise<HybridSearchPipelineCandidate[]> {
    if (!this.deps.vectorStore) return [];
    try {
      const variants = await this.buildVariants(q.query);
      q.diag.queryVariants = variants;

      // Project isolation rides on the namespace; `type` stays a metadata filter.
      const namespace = codeNamespace(q.projectName);
      const filter: Record<string, string> = {};
      if (q.type === 'files') filter.type = 'file';
      else if (q.type === 'symbols') filter.type = 'symbol';

      const perVariant = Math.max(q.overFetch, 10);
      let totalRaw = 0;
      const variantResults: HybridSearchPipelineCandidate[][] = await Promise.all(
        variants.map(async (v) => {
          const { vector } = await this.deps.embeddingService.embedQuery(v);
          if (vector.length === 0) return [];
          const matches = await this.deps.vectorStore!.search(vector, { topK: perVariant, filter, namespace });
          totalRaw += matches.length;
          return this.rehydrate(matches, q.projectId);
        }),
      );
      q.diag.vectorRawMatches = totalRaw;

      // RRF across variants using the canonical helper — keeps parity
      // with the legacy `vectorSearchExpanded` per-variant fusion.
      const rankableLists = variantResults.map((items) => ({
        items: items.map((c) => ({ candidateId: c.candidateId })),
      }));
      const merged = cpRrfMerge(rankableLists, { k: RRF_K, limit: q.overFetch });

      // Reconstruct candidates in the merged order; preserve best vector_score
      const candidateByKey = new Map<string, HybridSearchPipelineCandidate>();
      for (const runResults of variantResults) {
        for (const c of runResults) {
          const existing = candidateByKey.get(c.candidateId);
          if (!existing) {
            candidateByKey.set(c.candidateId, c);
          } else if (
            c.result.vector_score !== null &&
            (existing.result.vector_score === null ||
              c.result.vector_score > existing.result.vector_score)
          ) {
            existing.result.vector_score = c.result.vector_score;
          }
        }
      }

      const orderedResults: HybridSearchPipelineCandidate[] = [];
      for (let i = 0; i < merged.length; i++) {
        const c = candidateByKey.get(merged[i].candidateId);
        if (!c) continue;
        c.ranks.vector = i + 1;
        orderedResults.push(c);
      }
      q.diag.vectorRehydrated = orderedResults.length;
      return orderedResults;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[hybrid-pipeline] vector source failed:', msg);
      q.diag.vectorError = msg;
      return [];
    }
  }

  private async buildVariants(query: string): Promise<string[]> {
    // Same shortcut as the legacy path: identifier-shaped queries skip the
    // HyDE LLM call and template expansion (covers callers that request
    // hybrid explicitly). Kill switch: MCP_HYBRID_HYDE_SKIP_FTS=0.
    if (process.env.MCP_HYBRID_HYDE_SKIP_FTS !== '0' && planQuery(query).mode === 'fts') {
      return [query.trim()];
    }
    if (this.deps.hyde) {
      const hypothetical = await this.deps.hyde.generate(query);
      if (hypothetical && hypothetical !== query) return [query, hypothetical];
    }
    return buildTemplateVariants(query);
  }

  private rehydrate(
    matches: Array<{ score: number; metadata: Record<string, string> }>,
    projectId?: number,
  ): HybridSearchPipelineCandidate[] {
    const out: HybridSearchPipelineCandidate[] = [];
    for (const match of matches) {
      const isFile = match.metadata.type === 'file';
      const refId = match.metadata.ref_id ? parseInt(match.metadata.ref_id, 10) : 0;
      if (!refId) continue;
      const data: DBFile | DBSymbol | undefined = isFile
        ? this.deps.db.getFileById(refId, projectId)
        : this.deps.db.getSymbolById(refId, projectId);
      if (!data) continue;
      const r: HybridSearchResult = {
        id: data.id,
        type: isFile ? 'file' : 'symbol',
        score: match.score,
        fts_rank: null,
        vector_score: match.score,
        data,
      };
      out.push(emptyCandidate(r));
    }
    return out;
  }
}

export class RecentFilesSourceStage
  implements Source<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>
{
  readonly name = 'recent';
  constructor(private deps: { db: CodeIndexDB; recent: RecentFilesSource | null }) {}

  enable(q: HybridSearchPipelineQuery): boolean {
    return (
      !!this.deps.recent &&
      process.env.MCP_PIPELINES_RECENT_FILES_SOURCE === '1' &&
      q.type !== 'symbols'
    );
  }

  async source(q: HybridSearchPipelineQuery): Promise<HybridSearchPipelineCandidate[]> {
    if (!this.deps.recent) return [];
    const matches = this.deps.recent.match(q.projectId, q.query, Math.max(5, q.limit));
    const out: HybridSearchPipelineCandidate[] = [];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const data = this.deps.db.getFileById(m.fileId, q.projectId);
      if (!data || data.project_id !== q.projectId) continue;
      const r: HybridSearchResult = {
        id: data.id,
        type: 'file',
        score: m.score,
        fts_rank: null,
        vector_score: null,
        data,
      };
      const c = emptyCandidate(r);
      c.ranks.recent = i + 1;
      out.push(c);
    }
    q.diag.recentFilesCount = out.length;
    return out;
  }
}

// ─── Scorer: RRF fusion ──────────────────────────────────────────────

export class RrfFusionScorer
  implements Scorer<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>
{
  readonly name = 'rrf_fusion';

  enable(): boolean {
    return true;
  }

  async score(
    _q: HybridSearchPipelineQuery,
    candidates: readonly HybridSearchPipelineCandidate[],
  ): Promise<Array<{ ok: true; candidate: HybridSearchPipelineCandidate }>> {
    // Sources fan-out in parallel, so the same candidateId may appear
    // multiple times in `candidates`. Group by candidateId, sum the RRF
    // contributions from each source, preserve best per-source metadata.
    type Acc = HybridSearchPipelineCandidate & { _summedFromIds: Set<string> };
    const byKey = new Map<string, Acc>();
    for (const c of candidates) {
      const existing = byKey.get(c.candidateId);
      if (!existing) {
        byKey.set(c.candidateId, { ...c, _summedFromIds: new Set() });
      } else {
        existing.ranks = {
          fts: existing.ranks.fts ?? c.ranks.fts,
          vector: existing.ranks.vector ?? c.ranks.vector,
          recent: existing.ranks.recent ?? c.ranks.recent,
        };
        // Preserve best vector_score for diagnostics
        if (
          c.result.vector_score !== null &&
          (existing.result.vector_score === null ||
            c.result.vector_score > existing.result.vector_score)
        ) {
          existing.result.vector_score = c.result.vector_score;
        }
        if (c.result.fts_rank !== null && existing.result.fts_rank === null) {
          existing.result.fts_rank = c.result.fts_rank;
        }
      }
    }

    // Compute RRF score per candidate. NOTE: candidates is the ORDER
    // the framework gave us — we return the SAME length/order array
    // (per the Scorer contract), but the result-side score is the
    // fused RRF. Duplicates across sources end up with identical
    // scores in their respective rows (the selector will dedup later).
    const fusedByKey = new Map<string, number>();
    for (const acc of byKey.values()) {
      let s = 0;
      if (acc.ranks.fts !== undefined) s += 1 / (RRF_K + acc.ranks.fts);
      if (acc.ranks.vector !== undefined) s += 1 / (RRF_K + acc.ranks.vector);
      if (acc.ranks.recent !== undefined) s += 1 / (RRF_K + acc.ranks.recent);
      fusedByKey.set(acc.candidateId, s);
    }

    return candidates.map((c) => ({
      ok: true as const,
      candidate: {
        ...c,
        score: fusedByKey.get(c.candidateId) ?? 0,
        ranks: byKey.get(c.candidateId)?.ranks ?? c.ranks,
        result: {
          ...c.result,
          score: fusedByKey.get(c.candidateId) ?? 0,
          fts_rank: byKey.get(c.candidateId)?.result.fts_rank ?? c.result.fts_rank,
          vector_score: byKey.get(c.candidateId)?.result.vector_score ?? c.result.vector_score,
        },
      },
    }));
  }

  update(candidate: HybridSearchPipelineCandidate, scored: HybridSearchPipelineCandidate): void {
    candidate.score = scored.score;
    candidate.result = scored.result;
    candidate.ranks = scored.ranks;
  }
}

// ─── Post-selection hydrator: dedup + rerank ─────────────────────────

/**
 * Deduplicates candidates by `candidateId` (sources fan-out can produce
 * the same row from FTS and vector; the scorer summed their RRF
 * contributions but `candidates` still contains duplicates). Runs
 * BEFORE the reranker so the cross-encoder sees each row once.
 *
 * Pre-selection rather than post-selection because the selector's
 * top-K math would otherwise count duplicates against the limit.
 */
export class DedupFilter implements Filter<HybridSearchPipelineQuery, HybridSearchPipelineCandidate> {
  readonly name = 'dedup';
  enable(): boolean {
    return true;
  }
  filter(
    _q: HybridSearchPipelineQuery,
    candidates: HybridSearchPipelineCandidate[],
  ): { kept: HybridSearchPipelineCandidate[]; removed: HybridSearchPipelineCandidate[] } {
    const seen = new Set<string>();
    const kept: HybridSearchPipelineCandidate[] = [];
    const removed: HybridSearchPipelineCandidate[] = [];
    for (const c of candidates) {
      if (seen.has(c.candidateId)) {
        removed.push(c);
      } else {
        seen.add(c.candidateId);
        kept.push(c);
      }
    }
    return { kept, removed };
  }
}

export class RerankerHydrator
  implements Hydrator<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>
{
  readonly name = 'reranker';
  constructor(private reranker: RerankerService) {}

  enable(): boolean {
    return !(this.reranker instanceof NullReranker);
  }

  async hydrate(
    q: HybridSearchPipelineQuery,
    candidates: readonly HybridSearchPipelineCandidate[],
  ): Promise<Array<{ ok: true; candidate: HybridSearchPipelineCandidate }>> {
    if (candidates.length === 0) {
      return [];
    }
    const rerankInput = candidates.map((c) => {
      const d = c.result.data as unknown as Record<string, unknown>;
      const text =
        c.result.type === 'file'
          ? `${d.path ?? ''}\n${d.summary ?? ''}\n${Array.isArray(d.concepts) ? d.concepts.join(', ') : ''}`
          : `${d.name ?? ''} (${d.kind ?? ''})\n${d.signature ?? ''}\n${d.comment ?? ''}`;
      return { id: c.candidateId, text, originalScore: c.score };
    });
    const reranked = await this.reranker.rerank(q.query, rerankInput, q.limit);
    const newScoreById = new Map(reranked.map((r) => [r.id, r.score]));
    return candidates.map((c) => {
      const newScore = newScoreById.get(c.candidateId) ?? c.score;
      return {
        ok: true as const,
        candidate: {
          ...c,
          score: newScore,
          result: { ...c.result, score: newScore },
        },
      };
    });
  }

  update(candidate: HybridSearchPipelineCandidate, hydrated: HybridSearchPipelineCandidate): void {
    candidate.score = hydrated.score;
    candidate.result = hydrated.result;
  }
}

// ─── SideEffect: cache write (when caller provides a sink) ───────────

export interface CacheWriteSinkArgs {
  setCache: (results: HybridSearchResult[]) => void;
}

export class CacheWriteSink
  implements SideEffect<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>
{
  readonly name = 'cache_write';
  constructor(private args: CacheWriteSinkArgs) {}
  enable(): boolean {
    return true;
  }
  async sideEffect(input: {
    query: HybridSearchPipelineQuery;
    selectedCandidates: HybridSearchPipelineCandidate[];
  }): Promise<void> {
    const results = input.selectedCandidates.map((c) => c.result);
    this.args.setCache(results);
  }
}

// ─── Helpers (shared with legacy method for parity) ──────────────────

function buildTemplateVariants(query: string): string[] {
  const trimmed = query.trim();
  const variants = new Set<string>();
  variants.add(trimmed);
  const topic = trimmed
    .replace(
      /^(how\s+(?:does|do|is|are|can|to)|what\s+(?:is|does|are)|where\s+(?:is|does|are)|why\s+(?:is|does|are))\s+/i,
      '',
    )
    .replace(/\?+\s*$/, '')
    .trim();
  if (topic && topic !== trimmed) {
    variants.add(`implementation of ${topic}`);
    variants.add(`function class ${topic}`);
  } else {
    variants.add(`${trimmed} implementation`);
  }
  return Array.from(variants).slice(0, 3);
}

// ─── Factory ──────────────────────────────────────────────────────────

export interface CreateHybridPipelineOptions {
  db: CodeIndexDB;
  vectorStore: VectorStore | null;
  embeddingService: EmbeddingService;
  hyde: HyDEService | null;
  reranker: RerankerService;
  recentFilesSource: RecentFilesSource | null;
  /** Sanitization helper from HybridSearch — keeps FTS parity (connector-aware). */
  ftsSanitize: (q: string, connector: 'AND' | 'OR') => string;
  /** Optional telemetry sink (e.g. SqliteTelemetrySink). */
  telemetry?: TelemetrySink;
  /** Optional cache writeback. */
  cacheWrite?: (results: HybridSearchResult[]) => void;
}

export function createHybridSearchPipeline(
  opts: CreateHybridPipelineOptions,
): CandidatePipeline<HybridSearchPipelineQuery, HybridSearchPipelineCandidate> {
  const rawInputs: RawSearchInputs = {
    db: opts.db,
    vectorStore: opts.vectorStore,
    embeddingService: opts.embeddingService,
    hyde: opts.hyde,
    recentFilesSource: opts.recentFilesSource,
    ftsSanitize: opts.ftsSanitize,
  };
  const sideEffects: SideEffect<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>[] = [];
  if (opts.cacheWrite) {
    sideEffects.push(new CacheWriteSink({ setCache: opts.cacheWrite }));
  }
  return new CandidatePipeline<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>(
    {
      name: 'indexer_search',
      telemetry: opts.telemetry,
      // The merge of multiple sources can produce many duplicates;
      // bump the safety cap above the framework default 10k so we
      // never trim before dedup runs.
      maxCandidates: 50_000,
    },
    {
      sources: [
        new FtsSource(rawInputs),
        new VectorSource(rawInputs),
        new RecentFilesSourceStage({ db: opts.db, recent: opts.recentFilesSource }),
      ],
      filters: [new DedupFilter()],
      scorers: [new RrfFusionScorer()],
      selector: new TopKSelector<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>({
        k: 20, // overridden per-call via query.limit
        scoreOf: (c) => c.score,
      }),
      postSelectionHydrators:
        opts.reranker instanceof NullReranker ? undefined : [new RerankerHydrator(opts.reranker)],
      sideEffects: sideEffects.length > 0 ? sideEffects : undefined,
    },
  );
}

/**
 * Convenience: run the pipeline and unwrap the candidates back to
 * `HybridSearchResult[]`. The caller still owns the cache-key /
 * planner / mode-selection logic — this helper is purely
 * candidates-in → ranked-results-out.
 */
export async function runHybridSearchPipeline(
  pipeline: CandidatePipeline<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>,
  query: HybridSearchPipelineQuery,
): Promise<HybridSearchResult[]> {
  const result = await pipeline.execute(query);
  // Selector picked top-N where N = TopKSelector default; honor the
  // caller's `query.limit` here for the final slice.
  return result.selected.slice(0, query.limit).map((c) => c.result);
}

// Re-export the snapshot type so callers can use it without dragging
// `@ctx/shared/types` in.
export type { ContextSnapshot };
