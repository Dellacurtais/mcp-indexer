/**
 * RecentFilesSource — "Thunder-style" in-memory hot cache of files the
 * current user has touched recently (read, edited, viewed in the IDE).
 *
 * **Inspired by** xai-org/x-algorithm's `home-mixer/sources/thunder_source.rs`,
 * which keeps a per-user in-memory store of in-network posts for sub-ms
 * lookups. The analog here: recently-touched files dominate the next few
 * queries (the user just edited `hybrid.ts` and now searches "hybrid RRF
 * merge" — Thunder hit pays off immediately).
 *
 * **Sprint 1 scope**: this class is purely additive. Behind the flag
 * `MCP_PIPELINES_RECENT_FILES_SOURCE=1` it can be consulted by
 * `HybridSearch` as a 3rd stream alongside FTS+vector and merged via RRF.
 * **Default OFF**: the class can exist without anyone calling it.
 *
 * **Why not LruCache from @ctx/candidate-pipeline?** We need to iterate
 * all entries to score them against a query — that LRU doesn't expose
 * iteration. A plain Map keeps things simple and fast; bounded N
 * (default 50) makes O(N) scans trivial.
 *
 * **Eviction**: simple capacity bound — on touch, if size > maxSize, drop
 * the least-recently-touched entry. This is `LRU` enough for the
 * workload (50 slots cycle in seconds during active coding) and avoids
 * the overhead of a real LRU's `delete-then-insert` move.
 */

export interface RecentFileEntry {
  projectId: number;
  fileId: number;
  filePath: string;
  /** Last-touch wall-clock ms. Newer = more relevant. */
  lastTouchMs: number;
  /** Whether the user viewed, edited, or both. Edit beats view in ties. */
  kind: 'view' | 'edit';
}

export interface RecentFilesSourceOptions {
  /** Max entries. Default 50 — generous for a single active coding session. */
  maxSize?: number;
}

export interface RecentFilesMatch extends RecentFileEntry {
  /** Score in [0, 1] — combines recency decay + filename token match. */
  score: number;
  /** Diagnostic — which terms from the query matched the file path. */
  matchedTerms: string[];
}

const DEFAULT_MAX_SIZE = 50;
/** Half-life for recency decay: 5 minutes. After 5min, weight halves. */
const RECENCY_HALF_LIFE_MS = 5 * 60 * 1000;

/**
 * Returns 1.0 at lastTouchMs=now, 0.5 at half-life, 0.25 at 2 half-lives, etc.
 * Same shape as `recencyDecay` from @ctx/candidate-pipeline but we don't
 * import to keep this module dependency-free (callable from search-bundle).
 */
function decay(lastTouchMs: number, nowMs: number): number {
  const age = Math.max(0, nowMs - lastTouchMs);
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

/** Tokens of length ≥ 2 are scoring-relevant. Single letters are too noisy. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function basename(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

export class RecentFilesSource {
  /** Keyed by `${projectId}:${fileId}` for O(1) update on touch. */
  private entries = new Map<string, RecentFileEntry>();
  private readonly maxSize: number;

  constructor(opts: RecentFilesSourceOptions = {}) {
    this.maxSize = Math.max(1, opts.maxSize ?? DEFAULT_MAX_SIZE);
  }

  /**
   * Record that a file was just touched. Subsequent calls for the same
   * (projectId, fileId) update `lastTouchMs` and bump `kind` to `'edit'`
   * if any prior call was an edit (edit "wins" over view).
   */
  touch(entry: Omit<RecentFileEntry, 'lastTouchMs'> & { lastTouchMs?: number }): void {
    const key = `${entry.projectId}:${entry.fileId}`;
    const now = entry.lastTouchMs ?? Date.now();
    const existing = this.entries.get(key);
    // Preserve edit kind across subsequent views (edit > view).
    const kind: RecentFileEntry['kind'] =
      existing?.kind === 'edit' || entry.kind === 'edit' ? 'edit' : 'view';

    // Re-insert at the end of Map iteration order so eviction picks the
    // genuine least-recently-touched entry.
    if (existing) this.entries.delete(key);
    this.entries.set(key, {
      projectId: entry.projectId,
      fileId: entry.fileId,
      filePath: entry.filePath,
      lastTouchMs: now,
      kind,
    });

    while (this.entries.size > this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  /** Drops all entries — useful on project switch or session end. */
  clear(): void {
    this.entries.clear();
  }

  /** Drops entries for a specific project — useful on indexer reindex. */
  clearProject(projectId: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.projectId === projectId) this.entries.delete(key);
    }
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Scan all entries for a project, score by recency × filename token match,
   * return up to `limit` matches sorted by score descending.
   *
   * Bounded scan (N ≤ maxSize, default 50) — sub-ms.
   *
   * Score formula:
   *   recencyWeight = 0.5 ^ (age / 5min)        — exp decay
   *   tokenMatchScore = matchedTerms / queryTerms (0..1)
   *   editBonus = +0.1 if kind === 'edit' (small lift)
   *   score = recencyWeight × (0.4 + 0.6 × tokenMatchScore) + editBonus
   *
   * The 0.4 floor means even a non-matching but VERY recent edit gets a
   * lift (helps the "I just edited X, search Y" case where Y doesn't
   * appear in X's filename).
   */
  match(projectId: number, query: string, limit = 5, nowMs: number = Date.now()): RecentFilesMatch[] {
    if (this.entries.size === 0 || limit <= 0) return [];
    const tokens = tokenize(query);

    const results: RecentFilesMatch[] = [];
    for (const entry of this.entries.values()) {
      if (entry.projectId !== projectId) continue;
      const filename = basename(entry.filePath).toLowerCase();
      const pathLower = entry.filePath.toLowerCase();
      const matched: string[] = [];
      for (const token of tokens) {
        if (pathLower.includes(token) || filename.includes(token)) {
          matched.push(token);
        }
      }
      const tokenMatchScore = tokens.length > 0 ? matched.length / tokens.length : 0;
      const recency = decay(entry.lastTouchMs, nowMs);
      const editBonus = entry.kind === 'edit' ? 0.1 : 0;
      const score = recency * (0.4 + 0.6 * tokenMatchScore) + editBonus;
      results.push({ ...entry, score, matchedTerms: matched });
    }

    // Highest score wins; ties broken by recency.
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.lastTouchMs - a.lastTouchMs;
    });
    return results.slice(0, limit);
  }
}
