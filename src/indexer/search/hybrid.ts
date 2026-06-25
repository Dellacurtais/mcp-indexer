import type { CodeIndexDB } from '@ctx/store/db.js';
import type { VectorStore } from '@ctx/store/vectors.js';
import { buildFtsMatch, ftsTokens } from '@ctx/store/db/fts-query.js';
import type { EmbeddingService } from '@ctx/indexer/search/embeddings.js';
import { NullEmbeddingService } from '@ctx/indexer/search/embeddings.js';
import type { HyDEService } from '@ctx/indexer/search/hyde.js';
import type { RerankerService } from '@ctx/indexer/search/reranker.js';
import { planQuery } from '@ctx/indexer/search/planner.js';
import { NullReranker } from '@ctx/indexer/search/reranker.js';
import type { RecentFilesSource } from '@ctx/indexer/search/recent-files-source.js';
import type { HybridSearchResult, SearchMode, SearchType, DBFile, DBSymbol, ContextSnapshot } from '@ctx/shared/types.js';
import { codeNamespace } from '@ctx/shared/vector-namespace.js';
import { rrfMerge as cpRrfMerge } from '@ctx/candidate-pipeline/scorers/rrf.js';
import type { CandidatePipeline, TelemetrySink } from '@ctx/candidate-pipeline';
import {
  createHybridSearchPipeline,
  runHybridSearchPipeline,
  type HybridSearchPipelineCandidate,
  type HybridSearchPipelineQuery,
} from '@ctx/indexer/search/hybrid-pipeline.js';
import { expandGraph } from '@ctx/indexer/search/graph-expansion-source.js';

/** Diagnostic info returned alongside search results. */
export interface SearchDiagnostics {
  vectorAvailable: boolean;
  embeddingAvailable: boolean;
  queryVariants?: string[];
  vectorRawMatches?: number;
  vectorRehydrated?: number;
  vectorError?: string;
  ftsCount?: number;
  /** Set when the planner chose a backend on the caller's behalf. */
  plannerMode?: 'fts' | 'vector' | 'hybrid';
  plannerReason?: string;
  /**
   * Number of results contributed by the I2 RecentFilesSource stream
   * (in hybrid mode, when `MCP_PIPELINES_RECENT_FILES_SOURCE=1` and a
   * source is wired). Unset when the stream is off — preserves the
   * shape for downstream JSON consumers.
   */
  recentFilesCount?: number;
  /**
   * Number of neighbors contributed by the 1-hop graph-expansion stream
   * (hybrid mode, `MCP_PIPELINES_GRAPH_EXPANSION=1`). Unset when off.
   */
  graphExpansionCount?: number;
  /**
   * Results contributed by the raw-content word index
   * (`file_contents_fts`, migration 140) — the lexical stream that works on
   * structural-only projects and matches text living only in code bodies.
   * Unset when the stream is off (`MCP_FTS_CONTENT_STREAM=0`) or empty.
   */
  contentCount?: number;
}

const RRF_K = 60;

/**
 * Map a 1-based FTS bm25 rank to a gentle, monotonic 0<score<=1 so agents can see
 * head-vs-tail confidence on FTS-only results. The rows are already bm25-ordered;
 * previously the score was hardcoded to 0 (rendered "0.000"), discarding the
 * signal. Only affects un-fused FTS results — RRF fusion re-ranks by position and
 * overwrites this score, so hybrid mode is unchanged.
 */
function ftsScore(rank: number): number {
  return Math.round((1 / (1 + Math.log2(rank))) * 1000) / 1000;
}

/** Positive-integer env knob with a fallback (NaN/0/negative → fallback). */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * Build 2-3 query variants for pseudo-HyDE expansion. The template phrases
 * nudge the embedding model toward code-space rather than question-space,
 * which measurably improves recall for NL questions on code corpora.
 */
function buildQueryVariants(query: string): string[] {
  const trimmed = query.trim();
  const variants = new Set<string>();
  variants.add(trimmed);

  // Strip common interrogative prefixes to get the topic.
  const topic = trimmed
    .replace(/^(how\s+(?:does|do|is|are|can|to)|what\s+(?:is|does|are)|where\s+(?:is|does|are)|why\s+(?:is|does|are))\s+/i, '')
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

export class HybridSearch {
  private reranker: RerankerService;
  /**
   * Optional "Thunder-style" in-memory hot cache of recently-touched files
   * (I2 — Sprint 1). Behind `MCP_PIPELINES_RECENT_FILES_SOURCE=1` and only
   * consulted in `mode='hybrid'`. When the flag is unset OR the source is
   * not provided, `runRecentSearch()` short-circuits to empty and the
   * downstream RRF merge runs with just FTS + Vector — bit-identical to
   * the pre-I2 behavior.
   */
  private recentFilesSource: RecentFilesSource | null;
  /**
   * Optional telemetry sink for the I1 pipeline path. When wired, the
   * V2 pipeline emits per-stage rows to `pipeline_telemetry`. Unset →
   * pipeline still works, just no observability writes.
   */
  private pipelineTelemetry: TelemetrySink | null;
  /**
   * Lazy-instantiated I1 pipeline. Built on first V2 invocation; reused
   * across calls. The factory is cheap (no I/O), but constructing it
   * once amortizes some closure setup across many searches.
   */
  private v2Pipeline: CandidatePipeline<HybridSearchPipelineQuery, HybridSearchPipelineCandidate> | null = null;

  /** LRU query cache: key = `${projectId}:${query}:${mode}:${type}` → results + the diagnostics of the run that produced them */
  private queryCache = new Map<string, { results: HybridSearchResult[]; diagnostics: SearchDiagnostics; ts: number }>();
  private readonly queryCacheMax = 128;
  private readonly queryCacheTtlMs = 5 * 60 * 1000; // 5 min

  constructor(
    private db: CodeIndexDB,
    private vectorStore: VectorStore | null,
    private embeddingService: EmbeddingService,
    private hydeService: HyDEService | null = null,
    reranker?: RerankerService | null,
    recentFilesSource?: RecentFilesSource | null,
    pipelineTelemetry?: TelemetrySink | null,
  ) {
    this.reranker = reranker ?? new NullReranker();
    this.recentFilesSource = recentFilesSource ?? null;
    this.pipelineTelemetry = pipelineTelemetry ?? null;
  }

  /**
   * I1 — V2 path through `@ctx/candidate-pipeline`. Returns the same
   * `HybridSearchResult[]` shape as the legacy hybrid branch but runs
   * through the framework stages so per-stage telemetry and Decider
   * gating come for free. Gated by `MCP_PIPELINES_INDEXER_SEARCH_V2=1`.
   *
   * The legacy path keeps its caching, planner, and dual-stream RRF.
   * V2 is only entered for `mode='hybrid'` AND when the flag is set —
   * default OFF behavior is bit-identical to pre-I1.
   */
  private async searchViaPipeline(
    projectId: number,
    projectName: string,
    query: string,
    type: SearchType,
    limit: number,
    overFetch: number,
    cacheSetter: (results: HybridSearchResult[]) => void,
    diagAccum: SearchDiagnostics,
  ): Promise<HybridSearchResult[]> {
    if (!this.v2Pipeline) {
      this.v2Pipeline = createHybridSearchPipeline({
        db: this.db,
        vectorStore: this.vectorStore,
        embeddingService: this.embeddingService,
        hyde: this.hydeService,
        reranker: this.reranker,
        recentFilesSource: this.recentFilesSource,
        ftsSanitize: (q, connector) => this.sanitizeFtsQuery(q, connector),
        telemetry: this.pipelineTelemetry ?? undefined,
        cacheWrite: cacheSetter,
      });
    }
    const pipelineQuery: HybridSearchPipelineQuery = {
      queryId: `hybrid_v2:${projectId}:${query}:${type}:${limit}`,
      projectId,
      projectName,
      query,
      type,
      overFetch,
      limit,
      diag: {},
    };
    const results = await runHybridSearchPipeline(this.v2Pipeline, pipelineQuery);
    // Propagate diagnostic fields the legacy code populates so the
    // user-facing SearchDiagnostics surface stays identical.
    if (pipelineQuery.diag.ftsCount !== undefined) diagAccum.ftsCount = pipelineQuery.diag.ftsCount;
    if (pipelineQuery.diag.vectorRawMatches !== undefined) diagAccum.vectorRawMatches = pipelineQuery.diag.vectorRawMatches;
    if (pipelineQuery.diag.vectorRehydrated !== undefined) diagAccum.vectorRehydrated = pipelineQuery.diag.vectorRehydrated;
    if (pipelineQuery.diag.vectorError !== undefined) diagAccum.vectorError = pipelineQuery.diag.vectorError;
    if (pipelineQuery.diag.queryVariants !== undefined) diagAccum.queryVariants = pipelineQuery.diag.queryVariants;
    if (pipelineQuery.diag.recentFilesCount !== undefined) diagAccum.recentFilesCount = pipelineQuery.diag.recentFilesCount;
    return results;
  }

  /** Invalidate query cache (call after indexing). */
  invalidateCache(): void {
    this.queryCache.clear();
  }

  async search(
    projectId: number,
    projectName: string,
    query: string,
    options?: { mode?: SearchMode; type?: SearchType; limit?: number }
  ): Promise<HybridSearchResult[]> {
    const { results } = await this.searchWithDiag(projectId, projectName, query, options);
    return results;
  }

  /** Search with diagnostic info — used by the API to surface feedback. */
  async searchWithDiag(
    projectId: number,
    projectName: string,
    query: string,
    options?: { mode?: SearchMode; type?: SearchType; limit?: number }
  ): Promise<{ results: HybridSearchResult[]; diagnostics: SearchDiagnostics }> {
    const requestedMode = options?.mode ?? 'auto';
    const type = options?.type ?? 'all';
    const limit = options?.limit ?? 20;
    // Per-source candidate depth before fusion. Tunable so RRF coverage can
    // be measured against latency instead of hardcoding the trade-off.
    const overFetch = limit * envInt('MCP_SEARCH_OVERFETCH_MULT', 3);

    // Resolve `auto` via the planner so callers don't pay hybrid cost
    // for queries that FTS handles in a tenth of the time. The chosen
    // mode is surfaced via diagnostics.
    let mode: 'fts' | 'vector' | 'hybrid';
    let plannerReason: string | undefined;
    if (requestedMode === 'auto') {
      const plan = planQuery(query);
      mode = plan.mode;
      plannerReason = plan.reason;
    } else {
      mode = requestedMode;
    }

    // Check cache (key includes resolved mode so `auto` and `hybrid`
    // share a result row when the planner picks `hybrid`).
    const cacheKey = `${projectId}:${query}:${mode}:${type}:${limit}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.queryCacheTtlMs) {
      // Return the diagnostics of the run that produced the entry — a
      // stripped object here made consumers (e.g. the agent-facing
      // diagnostics trailer) report "all fine" on cache hits even when the
      // cached run had degraded to FTS-only.
      return { results: cached.results, diagnostics: cached.diagnostics };
    }

    const diag: SearchDiagnostics = {
      vectorAvailable: !!this.vectorStore,
      embeddingAvailable: !(this.embeddingService instanceof NullEmbeddingService),
      ...(plannerReason ? { plannerMode: mode, plannerReason } : {}),
    };

    const cacheAndReturn = (r: { results: HybridSearchResult[]; diagnostics: SearchDiagnostics }) => {
      // Evict oldest if full
      if (this.queryCache.size >= this.queryCacheMax) {
        const oldest = [...this.queryCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) this.queryCache.delete(oldest[0]);
      }
      this.queryCache.set(cacheKey, { results: r.results, diagnostics: r.diagnostics, ts: Date.now() });
      return r;
    };

    if (mode === 'fts') {
      const results = await this.ftsSearch(projectId, query, type, limit);
      diag.ftsCount = results.length;
      // Top-up from the raw-content index: on structural-only projects
      // files_fts has empty summaries/concepts, so identifier queries that
      // live in code bodies would otherwise return nothing.
      if (results.length < limit) {
        const seen = new Set(results.filter((r) => r.type === 'file').map((r) => r.id));
        const extra = this.runContentSearch(projectId, query, type, limit)
          .filter((c) => !seen.has(c.id))
          .slice(0, limit - results.length);
        if (extra.length > 0) {
          results.push(...extra);
          diag.contentCount = extra.length;
        }
      }
      return cacheAndReturn({ results, diagnostics: diag });
    }

    if (mode === 'vector') {
      const results = await this.vectorSearchExpanded(projectId, projectName, query, type, limit, diag);
      return cacheAndReturn({ results, diagnostics: diag });
    }

    // Hybrid: merge FTS + Vector (+ optional RecentFilesSource) using RRF.
    // The recent-files stream is gated by `MCP_PIPELINES_RECENT_FILES_SOURCE=1`
    // and the constructor receiving a RecentFilesSource instance. Both
    // checks happen inside runRecentSearch — when off, it returns [] and
    // the 3-stream merge degrades to 2-stream identical to legacy behavior.
    const hybridDiag: SearchDiagnostics = { ...diag };

    // I1 — V2 path through @ctx/candidate-pipeline. Gated by env flag,
    // default OFF. When ON, the search routes through the framework
    // (same Sources/Scorer/Hydrator/SideEffect contract) and emits
    // per-stage rows to pipeline_telemetry. Legacy path remains for
    // bit-identical fallback when the flag is unset.
    if (process.env.MCP_PIPELINES_INDEXER_SEARCH_V2 === '1') {
      const v2Results = await this.searchViaPipeline(
        projectId,
        projectName,
        query,
        type,
        limit,
        overFetch,
        (results) => cacheAndReturn({ results, diagnostics: hybridDiag }),
        hybridDiag,
      );
      return { results: v2Results, diagnostics: hybridDiag };
    }

    const [ftsResults, vectorResults, recentResults, contentResults] = await Promise.allSettled([
      this.ftsSearch(projectId, query, type, overFetch),
      this.vectorSearchExpanded(projectId, projectName, query, type, overFetch, hybridDiag),
      this.runRecentSearch(projectId, query, type, Math.max(5, limit)),
      Promise.resolve(this.runContentSearch(projectId, query, type, Math.max(10, limit))),
    ]);

    const fts = ftsResults.status === 'fulfilled' ? ftsResults.value : [];
    const vec = vectorResults.status === 'fulfilled' ? vectorResults.value : [];
    const recent = recentResults.status === 'fulfilled' ? recentResults.value : [];
    const content = contentResults.status === 'fulfilled' ? contentResults.value : [];
    hybridDiag.ftsCount = fts.length;
    if (recent.length > 0) hybridDiag.recentFilesCount = recent.length;
    if (content.length > 0) hybridDiag.contentCount = content.length;

    // 1-hop graph expansion (flag-gated, default OFF) — seeds from the primary
    // FTS+vector union and surfaces callers/importers/imports as an extra stream.
    const graph = this.runGraphSearch(projectId, [...fts, ...vec], type);
    if (graph.length > 0) hybridDiag.graphExpansionCount = graph.length;

    // How many fused candidates the reranker scores (cross-encoder cost is
    // linear in this). Default keeps the historical limit*2.
    const rerankDepth = envInt('MCP_RERANK_DEPTH', limit * 2);
    const merged = recent.length > 0 || graph.length > 0 || content.length > 0
      ? this.rrfMergeStreams(
          [
            { name: 'fts', results: fts },
            { name: 'vector', results: vec },
            ...(recent.length > 0 ? [{ name: 'recent', results: recent }] : []),
            ...(graph.length > 0 ? [{ name: 'graph', results: graph }] : []),
            ...(content.length > 0 ? [{ name: 'content', results: content }] : []),
          ],
          rerankDepth,
        )
      : this.rrfMerge(fts, vec, rerankDepth); // Over-fetch for re-ranking

    // Re-rank if a cross-encoder is configured
    if (merged.length > 0 && !(this.reranker instanceof NullReranker)) {
      const reranked = await this.reranker.rerank(
        query,
        merged.map(r => {
          const d = r.data as unknown as Record<string, unknown>;
          const text = r.type === 'file'
            ? `${d.path ?? ''}\n${d.summary ?? ''}\n${Array.isArray(d.concepts) ? d.concepts.join(', ') : ''}`
            : `${d.name ?? ''} (${d.kind ?? ''})\n${d.signature ?? ''}\n${d.comment ?? ''}`;
          return { id: `${r.type}:${r.id}`, text, originalScore: r.score };
        }),
        limit,
      );

      // Map reranked results back
      const idToScore = new Map(reranked.map(r => [r.id, r.score]));
      const rerankedResults = merged
        .filter(r => idToScore.has(`${r.type}:${r.id}`))
        .map(r => ({ ...r, score: idToScore.get(`${r.type}:${r.id}`)! }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return cacheAndReturn({ results: rerankedResults, diagnostics: hybridDiag });
    }

    return cacheAndReturn({ results: merged.slice(0, limit), diagnostics: hybridDiag });
  }

  /**
   * Content stream — MATCH over `file_contents_fts` (raw code text). The
   * lexical signal that still works on STRUCTURAL-only projects (files_fts
   * carries empty summaries there) and finds terms that live only in
   * function bodies. Same AND→OR fallback as ftsSearch. Synchronous; errors
   * (vtab missing on a pre-migration DB, malformed MATCH) degrade to [].
   * Kill switch: MCP_FTS_CONTENT_STREAM=0.
   */
  private runContentSearch(projectId: number, query: string, type: SearchType, limit: number): HybridSearchResult[] {
    if (process.env.MCP_FTS_CONTENT_STREAM === '0') return [];
    if (type === 'symbols') return [];
    try {
      const andQuery = this.sanitizeFtsQuery(query, 'AND');
      if (andQuery.length === 0) return [];
      let matches = this.db.searchFileContents(projectId, andQuery, limit);
      if (matches.length === 0 && ftsTokens(query).length > 1) {
        matches = this.db.searchFileContents(projectId, this.sanitizeFtsQuery(query, 'OR'), limit);
      }
      const out: HybridSearchResult[] = [];
      for (let i = 0; i < matches.length; i++) {
        const file = this.db.getFileById(matches[i].id, projectId);
        if (!file) continue;
        out.push({ id: file.id, type: 'file', score: ftsScore(i + 1), fts_rank: i + 1, vector_score: null, data: file });
      }
      return out;
    } catch {
      return [];
    }
  }

  private async ftsSearch(projectId: number, query: string, type: SearchType, limit: number): Promise<HybridSearchResult[]> {
    // Precision-first: require ALL terms (FTS5 AND). A multi-word query like
    // "user service create" should not match every doc mentioning just one of
    // them. If AND finds nothing, fall back to OR so a paraphrase that shares
    // only some terms is still recoverable (single-term queries are identical
    // either way, so the fallback is a no-op there).
    const results = this.runFtsQuery(projectId, query, type, limit, 'AND');
    if (results.length === 0 && ftsTokens(query).length > 1) {
      return this.runFtsQuery(projectId, query, type, limit, 'OR');
    }
    return results;
  }

  /** Run one FTS pass with a fixed boolean connector. */
  private runFtsQuery(
    projectId: number,
    query: string,
    type: SearchType,
    limit: number,
    connector: 'AND' | 'OR',
  ): HybridSearchResult[] {
    const results: HybridSearchResult[] = [];
    const ftsQuery = this.sanitizeFtsQuery(query, connector);
    if (ftsQuery.length === 0) return results;

    if (type === 'files' || type === 'all') {
      const files = this.db.searchFiles(projectId, ftsQuery, limit);
      for (let i = 0; i < files.length; i++) {
        results.push({
          id: files[i].id,
          type: 'file',
          score: ftsScore(i + 1),
          fts_rank: i + 1,
          vector_score: null,
          data: files[i],
        });
      }
    }

    if (type === 'symbols' || type === 'all') {
      const symbols = this.db.searchSymbols(projectId, ftsQuery, limit);
      for (let i = 0; i < symbols.length; i++) {
        results.push({
          id: symbols[i].id,
          type: 'symbol',
          score: ftsScore(i + 1),
          fts_rank: i + 1,
          vector_score: null,
          data: symbols[i],
        });
      }
    }

    return results;
  }

  /**
   * Vector search with multi-query expansion and diagnostics.
   *
   * NL queries like "how create tools" don't match code embeddings well.
   * We expand the query into 2-3 variants (e.g. "implementation of create tools",
   * "function class create tools") and RRF-merge the per-variant results.
   * If a HyDE service is available, we also include a synthetic code snippet.
   */
  private async vectorSearchExpanded(
    projectId: number,
    projectName: string,
    query: string,
    type: SearchType,
    limit: number,
    diag: SearchDiagnostics,
  ): Promise<HybridSearchResult[]> {
    if (!this.vectorStore || this.embeddingService instanceof NullEmbeddingService) {
      diag.vectorError = !this.vectorStore
        ? 'No vector store configured'
        : 'No embedding service configured';
      return [];
    }

    try {
      // Build query variants for better NL→code recall.
      // Identifier-shaped queries gain nothing from HyDE — the LLM call adds
      // 200-400ms and the synthetic snippet drifts away from exact-name
      // matching — so when the planner classifies the query as fts-shaped,
      // embed only the raw query. Kill switch: MCP_HYBRID_HYDE_SKIP_FTS=0.
      const skipExpansion = process.env.MCP_HYBRID_HYDE_SKIP_FTS !== '0'
        && planQuery(query).mode === 'fts';
      let variants: string[];
      if (skipExpansion) {
        variants = [query.trim()];
      } else if (this.hydeService) {
        const hypothetical = await this.hydeService.generate(query);
        variants =
          hypothetical && hypothetical !== query
            ? [query, hypothetical]
            : buildQueryVariants(query);
      } else {
        variants = buildQueryVariants(query);
      }
      diag.queryVariants = variants;

      // Project isolation rides on the namespace now; `type` stays a metadata
      // filter to pick files vs symbols within the project.
      const namespace = codeNamespace(projectName);
      const filter: Record<string, string> = {};
      if (type === 'files') filter.type = 'file';
      else if (type === 'symbols') filter.type = 'symbol';

      const perVariant = Math.max(limit, 10);
      let totalRawMatches = 0;

      // Run each variant in parallel
      const runs = await Promise.all(
        variants.map(async (v) => {
          const { vector } = await this.embeddingService.embedQuery(v);
          if (vector.length === 0) return [];
          const matches = await this.vectorStore!.search(vector, { topK: perVariant, filter, namespace });
          totalRawMatches += matches.length;
          return this.rehydrateVectorMatches(matches, projectId);
        }),
      );

      diag.vectorRawMatches = totalRawMatches;

      // RRF merge across variants
      const scoreMap = new Map<string, HybridSearchResult>();
      for (const runResults of runs) {
        for (let rank = 0; rank < runResults.length; rank++) {
          const r = runResults[rank];
          const key = `${r.type}:${r.id}`;
          const delta = 1 / (RRF_K + rank + 1);
          const existing = scoreMap.get(key);
          if (existing) {
            existing.score += delta;
            // Keep the best vector_score
            if (r.vector_score && (!existing.vector_score || r.vector_score > existing.vector_score)) {
              existing.vector_score = r.vector_score;
            }
          } else {
            scoreMap.set(key, { ...r, score: delta });
          }
        }
      }

      const results = Array.from(scoreMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      diag.vectorRehydrated = results.length;
      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[hybrid-search] Vector search failed:', msg);
      diag.vectorError = msg;
      return [];
    }
  }

  /** Rehydrate vector matches from SQLite — shared by vectorSearchExpanded and snapshot search. */
  private rehydrateVectorMatches(
    matches: Array<{ score: number; metadata: Record<string, string> }>,
    projectId?: number,
  ): HybridSearchResult[] {
    const results: HybridSearchResult[] = [];
    for (const match of matches) {
      const isFile = match.metadata.type === 'file';
      const refId = match.metadata.ref_id ? parseInt(match.metadata.ref_id, 10) : 0;
      if (!refId) continue;

      const data: DBFile | DBSymbol | undefined = isFile
        ? this.db.getFileById(refId, projectId)
        : this.db.getSymbolById(refId, projectId);
      if (!data) continue;

      results.push({
        id: data.id,
        type: isFile ? 'file' : 'symbol',
        score: match.score,
        fts_rank: null,
        vector_score: match.score,
        data,
      });
    }
    return results;
  }

  /**
   * RRF merge of two ranked lists, delegating the scoring math to the
   * canonical `rrfMerge` in `@ctx/candidate-pipeline/scorers/rrf`. We layer
   * the indexer-specific per-source metadata (`fts_rank`, `vector_score`)
   * on top so diagnostics keep working.
   *
   * Paridade: `K = RRF_K = 60` matches the framework's `RRF_DEFAULT_K`.
   * See `packages/candidate-pipeline/src/__tests__/scorers.test.ts` for
   * the canonical formula.
   */
  private rrfMerge(
    ftsResults: HybridSearchResult[],
    vectorResults: HybridSearchResult[],
    limit: number
  ): HybridSearchResult[] {
    // Side channel: track first-occurrence metadata per (type, id) key.
    type Meta = { fts_rank: number | null; vector_score: number | null; original: HybridSearchResult };
    const meta = new Map<string, Meta>();
    for (let rank = 0; rank < ftsResults.length; rank++) {
      const r = ftsResults[rank];
      const key = `${r.type}:${r.id}`;
      if (!meta.has(key)) meta.set(key, { fts_rank: rank + 1, vector_score: null, original: r });
      else meta.get(key)!.fts_rank = rank + 1;
    }
    for (let rank = 0; rank < vectorResults.length; rank++) {
      const r = vectorResults[rank];
      const key = `${r.type}:${r.id}`;
      const existing = meta.get(key);
      if (!existing) meta.set(key, { fts_rank: null, vector_score: r.vector_score, original: r });
      else existing.vector_score = r.vector_score;
    }

    // Frame each source as a Rankable<candidateId=`type:id`> for cpRrfMerge.
    const ftsRankable = ftsResults.map((r) => ({ candidateId: `${r.type}:${r.id}` }));
    const vecRankable = vectorResults.map((r) => ({ candidateId: `${r.type}:${r.id}` }));
    const merged = cpRrfMerge(
      [
        { name: 'fts', items: ftsRankable },
        { name: 'vector', items: vecRankable },
      ],
      { k: RRF_K, limit },
    );

    // Reconstruct HybridSearchResult preserving original payload + metadata.
    return merged.map(({ candidateId, rrfScore }) => {
      const m = meta.get(candidateId)!;
      return { ...m.original, score: rrfScore, fts_rank: m.fts_rank, vector_score: m.vector_score };
    });
  }

  /**
   * I2 — RRF merge with the optional 3rd "recent files" stream. Mirrors
   * `rrfMerge` but adds a third ranked input. Each list contributes a
   * `1 / (K + rank)` weight per the canonical RRF; the cpRrfMerge sums
   * across all sources where a candidate appears, naturally rewarding
   * items that show up in MULTIPLE streams (FTS hit + just-edited file).
   *
   * Behavior when `recentResults` is empty matches `rrfMerge` exactly —
   * verified by reusing the cpRrfMerge path. Diagnostics retain `fts_rank`
   * and `vector_score`; we don't add a per-result `recent_rank` field on
   * `HybridSearchResult` yet (it would touch shared types). The `recent`
   * stream's contribution is reflected in `diag.recentFilesCount`.
   */
  private rrfMergeStreams(
    streams: Array<{ name: string; results: HybridSearchResult[] }>,
    limit: number,
  ): HybridSearchResult[] {
    type Meta = { fts_rank: number | null; vector_score: number | null; original: HybridSearchResult };
    const meta = new Map<string, Meta>();
    // First stream to mention a candidate owns its `original` (richer metadata);
    // fts/vector contribute their rank/score, other streams (recent, graph) just
    // ensure the Meta exists so the merged candidate keeps its `data` reference.
    for (const { name, results } of streams) {
      for (let rank = 0; rank < results.length; rank++) {
        const r = results[rank];
        const key = `${r.type}:${r.id}`;
        const existing = meta.get(key);
        if (!existing) {
          meta.set(key, {
            fts_rank: name === 'fts' ? rank + 1 : null,
            vector_score: name === 'vector' ? r.vector_score : null,
            original: r,
          });
        } else {
          if (name === 'fts' && existing.fts_rank === null) existing.fts_rank = rank + 1;
          if (name === 'vector' && existing.vector_score === null) existing.vector_score = r.vector_score;
        }
      }
    }

    const merged = cpRrfMerge(
      streams.map((s) => ({ name: s.name, items: s.results.map((r) => ({ candidateId: `${r.type}:${r.id}` })) })),
      { k: RRF_K, limit },
    );

    return merged.map(({ candidateId, rrfScore }) => {
      const m = meta.get(candidateId)!;
      return { ...m.original, score: rrfScore, fts_rank: m.fts_rank, vector_score: m.vector_score };
    });
  }

  /**
   * 1-hop graph-expansion stream (flag-gated). Short-circuits to empty unless
   * `MCP_PIPELINES_GRAPH_EXPANSION=1`, so the merge stays bit-identical to the
   * pre-graph path when off. Seeds from the primary FTS+vector union; pure SQL;
   * best-effort (any error → empty, never breaks search).
   */
  private runGraphSearch(
    projectId: number,
    primary: HybridSearchResult[],
    type: SearchType,
  ): HybridSearchResult[] {
    if (process.env.MCP_PIPELINES_GRAPH_EXPANSION !== '1') return [];
    if (primary.length === 0) return [];
    try {
      return expandGraph(this.db, projectId, primary, type);
    } catch {
      return [];
    }
  }

  /**
   * I2 — consults the in-memory hot cache of recently-touched files.
   * Short-circuits to empty unless both:
   *   1. `MCP_PIPELINES_RECENT_FILES_SOURCE=1` is set, AND
   *   2. A `RecentFilesSource` was passed to the constructor.
   *
   * Both checks here mean the hybrid mode branch can call this
   * unconditionally — the flag/source absence keeps the merge identical
   * to the legacy 2-stream path.
   */
  private async runRecentSearch(
    projectId: number,
    query: string,
    type: SearchType,
    limit: number,
  ): Promise<HybridSearchResult[]> {
    if (process.env.MCP_PIPELINES_RECENT_FILES_SOURCE !== '1') return [];
    if (!this.recentFilesSource) return [];
    // The hot cache only knows about files. When the caller asked for
    // symbols-only there's nothing to contribute.
    if (type === 'symbols') return [];

    const matches = this.recentFilesSource.match(projectId, query, limit);
    const results: HybridSearchResult[] = [];
    for (const m of matches) {
      const data = this.db.getFileById(m.fileId, projectId);
      if (!data || data.project_id !== projectId) continue;
      results.push({
        id: data.id,
        type: 'file',
        score: m.score,
        fts_rank: null,
        vector_score: null,
        data,
      });
    }
    return results;
  }

  /**
   * Query expansion for NL questions. Two modes:
   *
   *   1. **Real HyDE (when hydeService is provided)** — calls an LLM to draft
   *      a short hypothetical code snippet / docstring that would answer the
   *      query, then uses BOTH the raw query and the synthetic snippet as
   *      variants. Adds ~200-400ms of latency but dramatically improves
   *      recall for questions the codebase never phrases the same way.
   *
   *   2. **Template-based (fallback)** — rewrites `how does X work?` into
   *      `implementation of X` and `function class X`. Deterministic and
   *      free. Ships when no HyDE service is wired in the tool context.
   *
   * In both cases we run the hybrid search once per variant and RRF-merge
   * the results. Scores are normalized to each variant's rank so the raw
   * query doesn't dominate a strong HyDE match.
   */
  async searchExpanded(
    projectId: number,
    projectName: string,
    query: string,
    options?: { type?: SearchType; limit?: number }
  ): Promise<HybridSearchResult[]> {
    const type = options?.type ?? 'all';
    const limit = options?.limit ?? 20;

    // Real HyDE takes precedence when available; we still include the raw
    // query so exact-token matches aren't lost.
    let variants: string[];
    if (this.hydeService) {
      const hypothetical = await this.hydeService.generate(query);
      variants =
        hypothetical && hypothetical !== query
          ? [query, hypothetical]
          : buildQueryVariants(query);
    } else {
      variants = buildQueryVariants(query);
    }

    const perVariant = Math.max(limit, 10);
    const runs = await Promise.all(
      variants.map((v) => this.search(projectId, projectName, v, { mode: 'hybrid', type, limit: perVariant }))
    );

    // RRF merge across variants using the same K as rrfMerge.
    const scoreMap = new Map<string, HybridSearchResult>();
    for (const runResults of runs) {
      for (let rank = 0; rank < runResults.length; rank++) {
        const r = runResults[rank];
        const key = `${r.type}:${r.id}`;
        const delta = 1 / (RRF_K + rank + 1);
        const existing = scoreMap.get(key);
        if (existing) existing.score += delta;
        else scoreMap.set(key, { ...r, score: delta });
      }
    }

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Hybrid snapshot search: FTS5 + vector RRF merge. Falls back cleanly to
   * FTS-only if embeddings aren't configured or vector search fails. Returns
   * deduplicated snapshots ordered by combined score.
   */
  async searchSnapshotsHybrid(
    projectId: number,
    projectName: string,
    query: string,
    limit: number
  ): Promise<ContextSnapshot[]> {
    const ftsSnaps = this.db.searchSnapshots(projectId, query);

    // Vector side: only runs if embeddings + vector store are available.
    let vectorSnaps: ContextSnapshot[] = [];
    if (this.vectorStore && !(this.embeddingService instanceof NullEmbeddingService)) {
      try {
        const { vector } = await this.embeddingService.embedQuery(query);
        if (vector.length > 0) {
          // Snapshots are now chunked, so several matches can share a ref_id.
          // Over-fetch (×4) and keep the first (best-scored) chunk per
          // snapshot — dedup here keeps RRF ranks one-per-snapshot.
          // Snapshot vectors are upserted WITHOUT a namespace (they live wholly
          // on the central store), so scope them by the project_name metadata —
          // NOT the code: namespace. The old `namespace: code:<name>` never
          // matched (stored namespace is '') so semantic snapshot recall silently
          // returned nothing (FTS masked it); under per-project vector routing it
          // would also wrongly target the project store, which holds no snapshots.
          const matches = await this.vectorStore.search(vector, {
            topK: limit * 4,
            filter: { type: 'snapshot', project_name: projectName },
          });
          const seen = new Set<number>();
          for (const m of matches) {
            const refId = m.metadata.ref_id ? parseInt(m.metadata.ref_id, 10) : 0;
            if (!refId || seen.has(refId)) continue;
            seen.add(refId);
            const snap = this.db.getSnapshotById(refId);
            // Archived snapshots have their vectors dropped, but a stale vector
            // could linger until the delete drains — filter defensively.
            if (snap && snap.project_id === projectId && !snap.archived_at) vectorSnaps.push(snap);
          }
        }
      } catch (err) {
        console.error('[snapshot-search] vector side failed:', (err as Error).message);
      }
    }

    if (vectorSnaps.length === 0) return ftsSnaps.slice(0, limit);

    // RRF merge — rank is position within each list.
    const scoreMap = new Map<number, { snap: ContextSnapshot; score: number }>();
    for (let rank = 0; rank < ftsSnaps.length; rank++) {
      const s = ftsSnaps[rank];
      const score = 1 / (RRF_K + rank + 1);
      scoreMap.set(s.id, { snap: s, score });
    }
    for (let rank = 0; rank < vectorSnaps.length; rank++) {
      const s = vectorSnaps[rank];
      const score = 1 / (RRF_K + rank + 1);
      const existing = scoreMap.get(s.id);
      if (existing) existing.score += score;
      else scoreMap.set(s.id, { snap: s, score });
    }

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => e.snap);
  }

  /**
   * Build an FTS5 MATCH expression. Defaults to AND (every term must appear)
   * for precision; callers fall back to OR when AND returns nothing so recall
   * is preserved. Single-term queries are identical under either connector.
   * Delegates to the canonical quote-per-token builder in @ctx/store.
   */
  private sanitizeFtsQuery(query: string, connector: 'AND' | 'OR' = 'AND'): string {
    return buildFtsMatch(query, connector);
  }
}
