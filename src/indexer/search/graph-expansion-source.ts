/**
 * Graph-expansion source — 1-hop expansion over the ALREADY-MATCHED primary
 * results, surfacing structurally-related FILES that lexical/vector search
 * alone may miss (the multi-hop chain "issue → endpoint → service →
 * repository" that a vector DB loses):
 *
 *   - a matched SYMBOL → the files that CALL it (callers)
 *   - a matched FILE   → the files that IMPORT it (dependents) + the files it
 *                        IMPORTS (dependencies)
 *
 * Pure SQL (indexed lookups), no LLM/network. **1 hop only** — no transitive
 * walk — and hard-capped (seedN × perSeed, then maxResults) so a hub symbol
 * with hundreds of callers cannot blow up the candidate set. Neighbors already
 * in the primary set are dropped; the upstream RRF merge naturally rewards a
 * neighbor that ALSO hit FTS/vector.
 *
 * Ranked by neighbor FREQUENCY (a file reached from multiple seeds ranks
 * higher — cheap PageRank-lite), then by best seed rank. The emitted `score`
 * is provisional: the upstream RRF merge re-scores by rank position.
 *
 * Dormant data activated: `symbol_references` (call-extractor) and
 * `file_dependencies` (import resolver) are populated at index time but were
 * never consulted during retrieval until this source. Flag-gated by the
 * caller (`MCP_PIPELINES_GRAPH_EXPANSION`), default OFF.
 */
import type { CodeIndexDB } from '@ctx/store/db.js';
import type { DBFile, DBSymbol, HybridSearchResult, SearchType } from '@ctx/shared/types.js';

export interface GraphExpansionOptions {
  /** Top primary results to expand from. Default 5. */
  seedN?: number;
  /** Max neighbors collected per seed. Default 10. */
  maxNeighborsPerSeed?: number;
  /** Max neighbors returned overall. Default 20. */
  maxResults?: number;
}

const DEFAULT_SEED_N = 5;
const DEFAULT_MAX_NEIGHBORS_PER_SEED = 10;
const DEFAULT_MAX_RESULTS = 20;
const RRF_K = 60; // aligns the provisional score with the hybrid merge's K

export function expandGraph(
  db: CodeIndexDB,
  projectId: number,
  primary: HybridSearchResult[],
  type: SearchType,
  options: GraphExpansionOptions = {},
): HybridSearchResult[] {
  // The graph yields FILE neighbors only — nothing to add for a symbols-only ask.
  if (type === 'symbols') return [];
  const seedN = options.seedN ?? DEFAULT_SEED_N;
  const perSeed = options.maxNeighborsPerSeed ?? DEFAULT_MAX_NEIGHBORS_PER_SEED;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

  // Exclude anything already in the FULL primary set (not just the seeds).
  const present = new Set(primary.map((r) => `${r.type}:${r.id}`));

  // Seed from the first `seedN` UNIQUE primary results (primary is rank-ordered).
  const seeds: HybridSearchResult[] = [];
  const seenSeed = new Set<string>();
  for (const r of primary) {
    const key = `${r.type}:${r.id}`;
    if (seenSeed.has(key)) continue;
    seenSeed.add(key);
    seeds.push(r);
    if (seeds.length >= seedN) break;
  }
  if (seeds.length === 0) return [];

  // neighbor file id → { freq across seeds, earliest seed rank }
  const acc = new Map<number, { freq: number; bestSeedRank: number }>();
  seeds.forEach((seed, seedRank) => {
    for (const fid of collectNeighborFileIds(db, projectId, seed, perSeed)) {
      if (present.has(`file:${fid}`)) continue;
      const e = acc.get(fid);
      if (e) { e.freq++; if (seedRank < e.bestSeedRank) e.bestSeedRank = seedRank; }
      else acc.set(fid, { freq: 1, bestSeedRank: seedRank });
    }
  });

  // Frequency desc, then earliest seed rank, then file id (stable tie-break).
  const ranked = [...acc.entries()].sort((a, b) =>
    b[1].freq - a[1].freq || a[1].bestSeedRank - b[1].bestSeedRank || a[0] - b[0],
  );

  const out: HybridSearchResult[] = [];
  for (let i = 0; i < ranked.length && out.length < maxResults; i++) {
    const data = db.getFileById(ranked[i][0], projectId);
    if (!data || data.project_id !== projectId) continue;
    out.push({ id: data.id, type: 'file', score: 1 / (RRF_K + i + 1), fts_rank: null, vector_score: null, data });
  }
  return out;
}

/** Up to `cap` neighbor file ids for one seed (callers / importers / imports). */
function collectNeighborFileIds(
  db: CodeIndexDB,
  projectId: number,
  seed: HybridSearchResult,
  cap: number,
): number[] {
  const ids: number[] = [];
  const push = (id: number | null | undefined): void => {
    if (typeof id === 'number' && ids.length < cap && !ids.includes(id)) ids.push(id);
  };

  if (seed.type === 'symbol') {
    // Files that call this symbol.
    const sym = seed.data as DBSymbol;
    for (const ref of db.getSymbolCallers(projectId, sym.name)) push(ref.referencing_file_id);
    return ids;
  }

  const file = seed.data as DBFile;
  // Files that import this file (dependents)…
  for (const dep of db.getDependents(projectId, file.id)) {
    push(db.getFileByPath(projectId, dep.source_file_path)?.id);
  }
  // …and the files it imports that resolve to indexed files (dependencies).
  for (const dep of db.getDependencies(file.id, projectId)) {
    if (dep.target_file_path) push(db.getFileByPath(projectId, dep.target_file_path)?.id);
  }
  return ids;
}
