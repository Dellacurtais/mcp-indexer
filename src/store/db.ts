import { runMigrations, getSchemaVersion } from './migrations/index.js';
import type {
  Project, DBFile, DBSymbol, IndexRun, CostSummary, ContextSnapshot, Webhook,
  FileSnapshot, VectorIdRecord, ProjectStats, DiscoveredModel, SnapshotCategory,
  SnapshotVersion, LLMSymbol, DBFileDependency, DBFileDependent,
  DBSymbolReference, DBSymbolRelation, RunKind,
} from '@ctx/shared/types.js';
import { Database, type DB, type PathAlias } from './db/types.js';
import { applyTuningPragmas } from './db/pragmas.js';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectDbFlags, type ProjectDbFlags } from '@ctx/shared/utils/config.js';
import {
  ProjectDbPool, resolveProjectDbLocation, openRawProjectDb, initProjectSchema, type ProjectDb,
} from './project-db/index.js';
import {
  splitProject, type SplitOutcome,
  splitProjectVectors, centralVectorsPath, projectVectorsPath,
  purgeProjectIndex,
} from './db-split/index.js';
import { SqliteVecVectorStore } from './sqlite-vec-store.js';
import type { VectorStore } from './vectors.js';
import { initSchema } from './db/schema/index.js';
import { repairCodeFtsIndexes } from './db/schema/fts.js';
import * as projects from './db/projects.js';
import * as files from './db/files.js';
import * as filesStructural from './db/files-structural.js';
import * as fileContents from './db/file-contents.js';
import * as symbols from './db/symbols.js';
import * as symbolRelations from './db/symbol-relations.js';
import * as runs from './db/runs.js';
import * as snapshots from './db/snapshots.js';
import * as snapshotsArchive from './db/snapshots-archive.js';
import * as memoryConsolidation from './db/memory-consolidation.js';
import * as memoryDistillLog from './db/memory-distill-log.js';
import * as costs from './db/costs.js';
import * as webhooks from './db/webhooks.js';
import * as vectors from './db/vectors.js';
import * as embeddings from './db/embeddings.js';
import * as modelsCache from './db/models-cache.js';
import * as stats from './db/stats.js';
import * as deps from './db/dependencies.js';
import * as maintenance from './db/maintenance.js';
import { loadTsconfigPathAliases } from './db/path-resolver.js';
import { ReadCache } from './db/read-cache.js';

/** Short-TTL caches for the synchronous reads that freeze the main thread on
 *  project open. Bounded staleness self-heals against cross-process worker
 *  writes (see read-cache.ts); main-side writes invalidate eagerly. */
const numEnv = (name: string, fallback: number): number => {
  const n = Number(process.env[name]); // NaN-safe: a garbage value falls back, not to NaN (which would disable the cache)
  return Number.isFinite(n) ? n : fallback;
};
const STATS_CACHE_TTL_MS = numEnv('MCP_DB_STATS_CACHE_MS', 2000);
const LIST_CACHE_TTL_MS = numEnv('MCP_DB_LIST_CACHE_MS', 3000);

/**
 * Real constituent of a SYNTHETIC union project (global session). Lightweight
 * mirror of code-agent's `LinkedProject` (kept local because @ctx/store must
 * not depend on @ctx/code-agent).
 */
export interface UnionProjectLink {
  project_id: number;
  name: string;
  root_path: string;
  is_primary: boolean;
}

export class CodeIndexDB {
  private db: DB;
  /** Central DB file path (for ATTACH + backup during the split). */
  private readonly centralDbPath: string;
  /** Cached tsconfig aliases per project id. Populated lazily. */
  private aliasCache = new Map<number, PathAlias[]>();
  /** Tiered-hybrid split flags, read once at construction. */
  private readonly pdbFlags: ProjectDbFlags;
  /** Per-project DB pool (tiered-hybrid split). Lazily opens project DBs. */
  private readonly projectPool: ProjectDbPool;
  /** Cache of the routing decision per project id (avoids a SELECT per call). */
  private readonly routeCache = new Map<number, boolean>();
  /** Short-TTL read cache for the main-thread-freezing hot reads (getStats,
   *  listProjects). Invalidated on the centralized write methods below. */
  private readonly readCache = new ReadCache();
  /** Lazily-built per-project code-vector stores (R2 routing). Closed on evict. */
  private readonly codeVecStores = new Map<number, SqliteVecVectorStore>();
  /** This process's boot time (SQL datetime fmt) — the C3 purge soak gate: only
   *  purge a project whose split landed in a PRIOR session (db_split_at < this). */
  private bootedAt = '';

  constructor(dbPath: string) {
    this.centralDbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    this.db.pragma('foreign_keys = ON');
    applyTuningPragmas(this.db);
    // Schema must exist before migrations that ALTER it.
    initSchema(this.db);
    runMigrations(this.db);
    this.bootedAt = (this.db.prepare(`SELECT datetime('now') AS t`).get() as { t: string }).t;

    this.pdbFlags = projectDbFlags();
    this.projectPool = new ProjectDbPool({
      maxOpen: this.pdbFlags.maxOpen,
      idleTtlMs: this.pdbFlags.idleMs,
      resolve: (projectId) => ({ dbPath: this.resolveProjectDbPath(projectId) }),
    });
  }

  getSchemaVersion(): number { return getSchemaVersion(this.db); }
  /** better-sqlite3 handle for stores that need direct prepared-statement access. */
  raw(): DB { return this.db; }
  close(): void {
    this.projectPool.closeAll();
    this.db.close();
  }

  // ─── Tiered-hybrid per-project DB routing (plan §6/§7) ──────────────
  /** Are the split flags enabled at all? */
  get projectDbEnabled(): boolean { return this.pdbFlags.enabled; }

  /** The pooled handle for a project's own DB (opens it on first use). */
  forProject(projectId: number): ProjectDb { return this.projectPool.get(projectId); }

  /** Close + checkpoint all pooled project handles (shutdown / before file ops). */
  closeProjectPool(): void { this.projectPool.closeAll(); }

  /** Drop one project's pooled handle (e.g. before deleting its files). */
  evictProject(projectId: number): void {
    this.projectPool.evict(projectId);
    this.routeCache.delete(projectId);
  }

  /**
   * Resolve (and persist) a project's DB file path. Reads `projects.db_path`
   * first; computes + stamps it on first use. Used by the pool's resolver.
   */
  resolveProjectDbPath(projectId: number): string {
    const row = this.db.prepare('SELECT root_path, db_path FROM projects WHERE id = ?')
      .get(projectId) as { root_path?: string; db_path?: string } | undefined;
    if (row?.db_path) return row.db_path;
    const loc = resolveProjectDbLocation(projectId, row?.root_path, {
      forceFallback: this.pdbFlags.fallbackAll,
    });
    try {
      this.db.prepare('UPDATE projects SET db_path = ? WHERE id = ?').run(loc.dbPath, projectId);
    } catch { /* projects row may not exist yet (synthetic bootstrap) — non-fatal */ }
    return loc.dbPath;
  }

  /**
   * Whether project-scoped INDEX reads/writes for this project should target
   * its own DB. False (→ central) unless the split is enabled AND the project
   * has finished migrating (`db_split_status='done'`). The user-memory sentinel
   * (id 0) and synthetic union projects always stay central.
   */
  useProjectDb(projectId: number): boolean {
    // Routing is a SEPARATE opt-in from the split/copy (plan §7 / P2b). Until the
    // full projectId-threading is complete + verified, the engine copies project
    // DBs but the app keeps reading/writing central (no bare-id breakage).
    if (!this.pdbFlags.enabled || !this.pdbFlags.route || projectId === 0) return false;
    const cached = this.routeCache.get(projectId);
    if (cached !== undefined) return cached;
    const row = this.db.prepare(
      'SELECT db_split_status AS s, COALESCE(is_synthetic, 0) AS syn FROM projects WHERE id = ?',
    ).get(projectId) as { s?: string; syn?: number } | undefined;
    const route = !!row && row.syn !== 1 && row.s === 'done';
    this.routeCache.set(projectId, route);
    return route;
  }

  /** Invalidate the routing cache for a project (after a status change). */
  invalidateRoute(projectId: number): void { this.routeCache.delete(projectId); }

  /** Read a project's split status marker. */
  getProjectSplitStatus(projectId: number): string {
    const row = this.db.prepare('SELECT db_split_status AS s FROM projects WHERE id = ?')
      .get(projectId) as { s?: string } | undefined;
    return row?.s ?? 'pending';
  }

  /** Update a project's split status marker + timestamp; clears the route cache. */
  setProjectSplitStatus(projectId: number, status: string, err?: string | null): void {
    this.db.prepare(
      `UPDATE projects
         SET db_split_status = ?, db_split_at = datetime('now'),
             db_split_err = ?
       WHERE id = ?`,
    ).run(status, err ?? null, projectId);
    this.routeCache.delete(projectId);
  }

  /**
   * Routed handle for project-scoped INDEX tables (files/symbols/runs/costs/…).
   * Central when the split is off or the project hasn't migrated yet.
   *
   * NOTE (P2): the INDEX method bodies are NOT yet converted to call this — the
   * routing flip is the final attended step (see plan §7 / morning notes). This
   * seam exists and is unit-tested; flag-off behavior is unchanged regardless.
   */
  private idx(projectId?: number): DB {
    if (projectId === undefined || !this.useProjectDb(projectId)) return this.db;
    const pdb = this.projectPool.get(projectId).raw();
    this.ensureProjectRow(projectId, pdb);
    return pdb;
  }

  /**
   * Public routed handle for project-scoped FEATURE stores (API client, builder
   * checkpoints, file local history, doc suggestions, project pipelines, DS
   * studio). Returns the project DB handle when the project is migrated +
   * routing is on, else the central handle. Feature stores are constructed
   * per-project on THIS handle (dual-mode) so their whole project-scoped graph
   * (e.g. collections→requests) lives in one DB — no per-method bare-id routing.
   */
  projectScopedDb(projectId: number): DB { return this.idx(projectId); }

  /** Project ids whose project-DB `projects` row has been seeded this session. */
  private readonly seededRows = new Set<number>();

  /**
   * The project DB reuses the full schema, so `files.project_id REFERENCES
   * projects(id)` is enforced inside it — a freshly-opened project DB (brand-new
   * project, or post-clearProjectData) needs its own catalog row or every write
   * fails the FK. Seed it once per session from the central catalog.
   */
  private ensureProjectRow(projectId: number, pdb: DB): void {
    if (this.seededRows.has(projectId)) return;
    const p = projects.get(this.db, projectId);
    if (p) {
      pdb.prepare('INSERT OR IGNORE INTO projects (id, name, root_path, description) VALUES (?, ?, ?, ?)')
        .run(p.id, p.name, p.root_path, p.description ?? null);
    }
    this.seededRows.add(projectId);
  }

  /** Run `fn` in a transaction on the ROUTED handle for a project (index writes). */
  indexTransaction<T>(projectId: number, fn: () => T): T {
    return this.idx(projectId).transaction(fn)();
  }

  /**
   * Lazily migrate a project's INDEX tables into its own DB on first index
   * (plan §8). No-op unless the split + splitIndex flags are on and the project
   * is still 'pending'. Runs the crash-safe copy→verify→done state machine
   * against the project's `.mcp-indexer/index.db`; central is left intact
   * (purge deferred). Called from runStructuralIndex so it runs off the main
   * thread (indexer worker) or in the in-process executor alike.
   */
  ensureProjectSplit(projectId: number): SplitOutcome | null {
    if (!this.pdbFlags.enabled || !this.pdbFlags.splitIndex || projectId === 0) return null;
    let outcome: SplitOutcome | null = null;
    if (this.getProjectSplitStatus(projectId) !== 'done') {
      // Release any open handle on the file we may delete + recreate.
      this.projectPool.evict(projectId);
      outcome = splitProject({
        central: this.db,
        centralDbPath: this.centralDbPath,
        projectDbPath: this.resolveProjectDbPath(projectId),
        projectId,
        openFreshProjectDb: (path) => {
          const d = openRawProjectDb(path);
          initProjectSchema(d);
          return d;
        },
        classes: ['INDEX', 'FEATURE'],
        purgeMode: this.pdbFlags.purgeMode,
      });
      this.routeCache.delete(projectId);
    }
    // R2 — vectors split runs once the relational copy is 'done' (its OWN marker
    // + flag). Fire-and-forget + non-fatal: it must never block the index, and
    // code-vector routing stays on the central store until vectors_split_status
    // flips 'done' (else a relational-done/vectors-pending project would read an
    // empty per-project vectors.db and silently lose all code RAG).
    if (
      this.pdbFlags.vectors &&
      this.getProjectSplitStatus(projectId) === 'done' &&
      this.getVectorsSplitStatus(projectId) !== 'done'
    ) {
      void this.ensureProjectVectorsSplit(projectId).catch(() => { /* non-fatal */ });
    }
    // C3 — reclaim central space: delete this project's INDEX rows from central
    // once it's 'done', soaked (split in a PRIOR session), and not yet purged.
    // Deferred by default (purgeMode); the one-time .bak is the rollback.
    // CRITICAL gate `useProjectDb`: routing MUST be live (route on + 'done') so
    // the app reads INDEX from the project DB — purging central INDEX while the
    // app still reads it (route off) would lose data. Non-fatal.
    if (
      this.pdbFlags.purgeMode === 'immediate' &&
      this.useProjectDb(projectId) &&
      this.shouldPurgeIndex(projectId)
    ) {
      try {
        purgeProjectIndex(this.db, projectId);
        this.db.prepare(`UPDATE projects SET db_purged_at = datetime('now') WHERE id = ?`).run(projectId);
      } catch { /* non-fatal — retried next open */ }
    }
    return outcome;
  }

  /** C3 purge gate: project 'done', never purged, and split in a prior session
   *  (soak — db_split_at predates this boot, so it survived ≥1 restart). */
  private shouldPurgeIndex(projectId: number): boolean {
    const row = this.db.prepare(
      `SELECT db_split_status AS s, db_split_at AS at, db_purged_at AS purged
         FROM projects WHERE id = ?`,
    ).get(projectId) as { s?: string; at?: string; purged?: string } | undefined;
    return !!row && row.s === 'done' && !row.purged && !!row.at && row.at < this.bootedAt;
  }

  /** Read a project's vectors-split status marker (R2). */
  getVectorsSplitStatus(projectId: number): string {
    const row = this.db.prepare('SELECT vectors_split_status AS s FROM projects WHERE id = ?')
      .get(projectId) as { s?: string } | undefined;
    return row?.s ?? 'pending';
  }

  private setVectorsSplitStatus(projectId: number, status: string, err?: string | null): void {
    this.db.prepare(
      `UPDATE projects SET vectors_split_status = ?, vectors_split_at = datetime('now'),
              vectors_split_err = ? WHERE id = ?`,
    ).run(status, err ?? null, projectId);
  }

  /**
   * Copy a project's code+snapshot vectors into its own vectors.db (R2). Runs
   * only after the relational split is 'done'. Non-fatal: a 'pending' outcome
   * leaves routing on the central store and retries on the next index.
   */
  private async ensureProjectVectorsSplit(projectId: number): Promise<void> {
    if (this.getVectorsSplitStatus(projectId) === 'done') return;
    const project = projects.get(this.db, projectId);
    if (!project) return;
    const outcome = await splitProjectVectors({
      centralVectorsPath: centralVectorsPath(this.centralDbPath),
      projectVectorsPath: projectVectorsPath(this.resolveProjectDbPath(projectId)),
      projectName: project.name,
      trackedVectorIds: this.getVectorIdStats(projectId).total,
    });
    this.setVectorsSplitStatus(projectId, outcome.status === 'done' ? 'done' : 'pending', outcome.reason ?? null);
  }

  /**
   * The vector store a project's CODE + snapshot vectors should read/write (R2
   * routing flip). Returns `central` UNCHANGED unless the vectors split is on,
   * the project has migrated (vectors_split_status='done'), AND the backend is
   * the embedded sqlite-vec store (remote backends isolate by namespace, so a
   * per-file split is meaningless). Flag-off / non-migrated / remote → `central`
   * (byte-identical to today). All consumers (HybridSearch, embed-executor,
   * SnapshotService) hold `db`, so the per-project routing decision + the open
   * connection cache + eviction live HERE, with no per-consumer wiring.
   *
   * Search and write MUST both route through this for a migrated project — else
   * re-embeds land in central while reads hit the per-project store (stale).
   */
  codeVectorStoreFor(projectId: number, central: VectorStore | null): VectorStore | null {
    if (!this.pdbFlags.vectors || central === null) return central;
    if (!this.useProjectDb(projectId)) return central;
    if (this.getVectorsSplitStatus(projectId) !== 'done') return central;
    if (!(central instanceof SqliteVecVectorStore)) return central; // remote backend
    let store = this.codeVecStores.get(projectId);
    if (!store) {
      store = new SqliteVecVectorStore({ path: projectVectorsPath(this.resolveProjectDbPath(projectId)) });
      this.codeVecStores.set(projectId, store);
    }
    return store;
  }

  /** Close + drop a project's cached per-project vector store (before file teardown). */
  private evictCodeVectorStore(projectId: number): void {
    const store = this.codeVecStores.get(projectId);
    if (store) {
      store.close();
      this.codeVecStores.delete(projectId);
    }
  }
  /**
   * Run `fn` (synchronous) inside one SQLite transaction. Inner
   * `db.transaction` calls (files.upsert, symbols.upsert, …) become
   * savepoints, so composite persists commit or roll back as a unit.
   */
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  // ─── Projects ───────────────────────────────────────────────────
  createProject(name: string, rootPath: string, description?: string): Project {
    const project = projects.create(this.db, name, rootPath, description);
    // Tiered-hybrid: stamp the resolved project DB path so it's stable even if
    // the root later moves. A brand-new project has no central data to migrate,
    // so when the split is enabled it is born already-migrated ('done').
    if (this.pdbFlags.enabled) {
      try {
        const loc = resolveProjectDbLocation(project.id, rootPath, {
          forceFallback: this.pdbFlags.fallbackAll,
        });
        const status = this.pdbFlags.newProjects ? 'done' : 'pending';
        this.db.prepare('UPDATE projects SET db_path = ?, db_split_status = ? WHERE id = ?')
          .run(loc.dbPath, status, project.id);
        this.routeCache.delete(project.id);
      } catch { /* non-fatal: stamping is best-effort */ }
    }
    this.readCache.invalidateKey('projects:list');
    return project;
  }
  getProject(id: number): Project | undefined {
    // The central `projects` row already carries node_version/runner_shell/
    // runtime_versions; the upstream per-project `project_runtime_config` overlay
    // table is not in the baseline, so we skip it (avoids a guaranteed-failing
    // "no such table" query on a hot path).
    return projects.get(this.db, id);
  }
  getProjectByName(name: string): Project | undefined { return projects.getByName(this.db, name); }
  getProjectByPath(rootPath: string): Project | undefined { return projects.getByPath(this.db, rootPath); }
  listProjects(): Project[] {
    return this.readCache.get('projects:list', LIST_CACHE_TTL_MS, () => projects.list(this.db));
  }
  /** Synthetic global-session union projects (hidden from listProjects). */
  listSyntheticProjects(): Project[] { return projects.listSynthetic(this.db); }
  /**
   * Real constituent projects of a SYNTHETIC union project (global session),
   * deduped from the `coder_session_projects` junction rows of ANY session on
   * it, primary first. Mirrors `listUnionProjects` in code-agent's sessions
   * store; lives here so the runtime resolver and the host memory adapters can
   * expand a union from just its project id (all tables are central). Empty
   * when no session references the union.
   */
  listUnionProjectIds(syntheticProjectId: number): UnionProjectLink[] {
    const rows = this.db
      .prepare(
        `SELECT csp.project_id      AS project_id,
                p.name              AS name,
                p.root_path         AS root_path,
                MAX(csp.is_primary) AS is_primary
           FROM coder_session_projects csp
           JOIN coder_sessions s ON s.id = csp.coder_session_id
           JOIN projects p       ON p.id = csp.project_id
          WHERE s.project_id = ?
          GROUP BY csp.project_id
          ORDER BY is_primary DESC, csp.project_id ASC`,
      )
      .all(syntheticProjectId) as Array<{
        project_id: number;
        name: string;
        root_path: string;
        is_primary: number;
      }>;
    return rows.map((r) => ({
      project_id: r.project_id,
      name: r.name,
      root_path: r.root_path,
      is_primary: !!r.is_primary,
    }));
  }
  /**
   * Memory WRITE target for a project id: for a SYNTHETIC union project, its
   * PRIMARY real constituent (deterministic, persists past the ephemeral union
   * directory that gets swept when orphaned); for an ordinary project, itself.
   * Used by the host memory adapters so distill/save_note in a global session
   * land on the primary, never on the throwaway synthetic project.
   */
  resolveMemoryWriteProject(projectId: number): { id: number; name: string } {
    const project = this.getProject(projectId);
    if (!project) return { id: projectId, name: '' };
    if (!project.is_synthetic) return { id: project.id, name: project.name };
    const links = this.listUnionProjectIds(projectId);
    const primary = links.find((l) => l.is_primary) ?? links[0];
    return primary
      ? { id: primary.project_id, name: primary.name }
      : { id: project.id, name: project.name };
  }
  setProjectSummary(id: number, summary: string): void { projects.setSummary(this.db, id, summary); }
  updateProject(id: number, updates: Parameters<typeof projects.update>[2]): void {
    // Runtime/shell config (node_version/runtime_versions/runner_shell/
    // package_managers) lives in the routed `project_runtime_config` table
    // (migrations 168/169) so it travels with the project folder; the rest
    // stays on the central `projects` row. package_managers has NO central
    // column, so it MUST be destructured out (projects.update writes raw keys).
    const { node_version, runtime_versions, runner_shell, package_managers, ...rest } = updates;
    const cfg: Record<string, string | null> = {};
    if ('node_version' in updates) cfg.node_version = node_version ?? null;
    if ('runtime_versions' in updates) cfg.runtime_versions = runtime_versions ?? null;
    if ('runner_shell' in updates) cfg.runner_shell = runner_shell ?? null;
    if ('package_managers' in updates) cfg.package_managers = package_managers ?? null;
    if (Object.keys(cfg).length > 0) this.writeRuntimeConfig(id, cfg);
    if (Object.keys(rest).length > 0) projects.update(this.db, id, rest);
    // Counts/name/config changed → drop this project's cached stats + the list.
    this.readCache.invalidateProject(id);
    this.readCache.invalidateKey('projects:list');
  }

  /**
   * Overlay the 3 runtime/shell fields from the routed `project_runtime_config`
   * table onto a central project row. Reads via `idx(id)` (per-project DB when
   * the project is split+routed, else central); falls back to the central row
   * when a routed per-project DB has no config row yet (project split BEFORE
   * migration 168). Tolerant of a missing table (DBs not yet at mig 168).
   */
  private overlayRuntimeConfig(project: Project, id: number): Project {
    try {
      const sql = 'SELECT node_version, runtime_versions, runner_shell, package_managers FROM project_runtime_config WHERE project_id = ?';
      const routed = this.idx(id);
      let cfg = routed.prepare(sql).get(id) as
        | { node_version: string | null; runtime_versions: string | null; runner_shell: string | null; package_managers: string | null }
        | undefined;
      if (!cfg && routed !== this.db) cfg = this.db.prepare(sql).get(id) as typeof cfg;
      if (cfg) {
        project.node_version = cfg.node_version ?? null;
        project.runtime_versions = cfg.runtime_versions ?? null;
        project.runner_shell = cfg.runner_shell ?? null;
        project.package_managers = cfg.package_managers ?? null;
      }
    } catch {
      /* pre-168 DB (no table) — keep the legacy central columns as-is */
    }
    return project;
  }

  /** Upsert the runtime/shell config row in the routed DB for a project. */
  private writeRuntimeConfig(id: number, cfg: Record<string, string | null>): void {
    const routed = this.idx(id);
    if (routed !== this.db) {
      // Routed project's FIRST write: SEED the per-project row from the central
      // row (the mig-168 backfill or pre-split value) so a PARTIAL update never
      // silently NULLs the sibling fields — once the per-project row exists, the
      // overlay reads it wholesale and skips the central fallback.
      const has = routed.prepare('SELECT 1 FROM project_runtime_config WHERE project_id = ?').get(id);
      if (!has) {
        const c = this.db
          .prepare('SELECT node_version, runtime_versions, runner_shell, package_managers FROM project_runtime_config WHERE project_id = ?')
          .get(id) as { node_version: string | null; runtime_versions: string | null; runner_shell: string | null; package_managers: string | null } | undefined;
        routed
          .prepare('INSERT OR IGNORE INTO project_runtime_config (project_id, node_version, runtime_versions, runner_shell, package_managers) VALUES (?, ?, ?, ?, ?)')
          .run(id, c?.node_version ?? null, c?.runtime_versions ?? null, c?.runner_shell ?? null, c?.package_managers ?? null);
      }
    } else {
      routed.prepare('INSERT OR IGNORE INTO project_runtime_config (project_id) VALUES (?)').run(id);
    }
    const cols = Object.keys(cfg);
    const sets = cols.map((c) => `${c} = ?`).join(', ');
    routed.prepare(`UPDATE project_runtime_config SET ${sets} WHERE project_id = ?`).run(...cols.map((c) => cfg[c]), id);
  }
  /** Mark a project as a synthetic global-session union (hidden from listProjects). */
  setProjectSynthetic(id: number, synthetic: boolean): void {
    projects.setSynthetic(this.db, id, synthetic);
    this.readCache.invalidateKey('projects:list'); // synthetic hides from the list
  }
  deleteProject(id: number): void {
    // Tiered-hybrid: remove the per-project DB files (app-layer cascade — the
    // FK cascade can't cross DB files), then the central catalog row. Best-effort
    // file removal so a missing DB is harmless.
    this.removeProjectDbFiles(id);
    // project_runtime_config has no FK to projects (it lives per-project too),
    // so the central orphan row isn't cascaded — reap it explicitly.
    try { this.db.prepare('DELETE FROM project_runtime_config WHERE project_id = ?').run(id); } catch { /* pre-168 */ }
    projects.del(this.db, id);
    this.readCache.invalidateProject(id);
    this.readCache.invalidateKey('projects:list');
  }
  /** Wipe a project's data (index/sessions/snapshots/runs/costs) but KEEP its row. */
  clearProjectData(id: number): void {
    if (this.useProjectDb(id)) {
      // Clear the project DB's data tables IN PLACE (keeps its catalog row so
      // the FK stays satisfied), then reset the central denormalized counters
      // (the central projects row drives the project list).
      projects.clearData(this.idx(id), id);
      // The relational index is wiped — wipe the routed vectors.db too so search
      // doesn't surface vectors for files that no longer exist. Evict the open
      // handle first, then delete the file (a fresh empty one is reopened lazily
      // for future embeds). Central vectors orphan harmlessly (pre-existing).
      this.evictCodeVectorStore(id);
      const vp = projectVectorsPath(this.resolveProjectDbPath(id));
      for (const suffix of ['', '-wal', '-shm']) {
        try { rmSync(vp + suffix, { force: true }); } catch { /* best-effort */ }
      }
      this.db.prepare(
        `UPDATE projects SET file_count = 0, symbol_count = 0, last_indexed = NULL,
           structural_indexed_at = NULL, updated_at = datetime('now') WHERE id = ?`,
      ).run(id);
      this.readCache.invalidateProject(id);
      this.readCache.invalidateKey('projects:list'); // counts shown in the list reset to 0
      return;
    }
    projects.clearData(this.db, id);
    this.readCache.invalidateProject(id);
    this.readCache.invalidateKey('projects:list');
  }

  /** Evict the pooled handle and delete a project's DB files (index + vectors). */
  private removeProjectDbFiles(projectId: number): void {
    this.projectPool.evict(projectId);
    this.evictCodeVectorStore(projectId); // release the vectors.db handle before rm
    this.routeCache.delete(projectId);
    this.seededRows.delete(projectId);
    const row = this.db.prepare('SELECT root_path, db_path FROM projects WHERE id = ?')
      .get(projectId) as { root_path?: string; db_path?: string } | undefined;
    if (!row) return;
    const dbPath = row.db_path
      ?? resolveProjectDbLocation(projectId, row.root_path, { forceFallback: this.pdbFlags.fallbackAll }).dbPath;
    const vectorsPath = join(dirname(dbPath), 'vectors.db');
    for (const base of [dbPath, vectorsPath]) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { rmSync(base + suffix, { force: true }); } catch { /* best-effort */ }
      }
    }
  }
  /** Rebuild the code FTS5 indexes from the base tables — recovers SQLITE_CORRUPT_VTAB. */
  repairFtsIndexes(): void { repairCodeFtsIndexes(this.db); }
  resolveProject(name?: string, rootPath?: string): Project { return projects.resolve(this.db, name, rootPath); }

  // ─── Files ──────────────────────────────────────────────────────
  // NOTE (P2b routing flip): project-scoped INDEX methods route via
  // `this.idx(projectId)` — central when the split is off / project not 'done',
  // the project DB otherwise. Bare-id methods take an optional `projectId` so
  // hot callers (the indexer) can route them; absent → central (back-compat).
  upsertFile(projectId: number, data: files.UpsertFileData): number { return files.upsert(this.idx(projectId), projectId, data); }
  getFile(projectId: number, path: string): DBFile | undefined { return files.get(this.idx(projectId), projectId, path); }
  getFileById(id: number, projectId?: number): DBFile | undefined { return files.getById(this.idx(projectId), id); }
  getFileByPath(projectId: number, path: string): DBFile | undefined { return files.get(this.idx(projectId), projectId, path); }
  listFiles(projectId: number, language?: string): DBFile[] { return files.list(this.idx(projectId), projectId, language); }
  listFileScanMeta(projectId: number): files.FileScanMeta[] { return files.listScanMeta(this.idx(projectId), projectId); }
  touchFileMtime(projectId: number, path: string, mtimeMs: number): void { files.touchMtime(this.idx(projectId), projectId, path, mtimeMs); }
  deleteFile(projectId: number, path: string): void { files.del(this.idx(projectId), projectId, path); }
  deleteFilesByProject(projectId: number): void { files.delByProject(this.idx(projectId), projectId); }
  searchFiles(projectId: number, query: string, limit: number = 20): DBFile[] { return files.search(this.idx(projectId), projectId, query, limit); }
  saveFileSnapshot(data: files.FileSnapshotData): void { files.saveSnapshot(this.idx(data.projectId), data); }
  getFileSnapshots(runId: number, projectId?: number): FileSnapshot[] { return files.listSnapshots(this.idx(projectId), runId); }

  // ─── Structural layer (migration 139/140) ───────────────────────
  /** Partial upsert that NEVER touches the semantic columns — see files-structural.ts. */
  upsertFileStructural(projectId: number, data: filesStructural.UpsertStructuralData): { fileId: number; created: boolean } { return filesStructural.upsertStructural(this.idx(projectId), projectId, data); }
  setFileSemanticHash(projectId: number, path: string, contentHash: string): void { filesStructural.setSemanticHash(this.idx(projectId), projectId, path, contentHash); }
  setFileSemantic(projectId: number, path: string, data: { summary: string; concepts: string[]; layer: string; contentHash: string }): void { filesStructural.setFileSemantic(this.idx(projectId), projectId, path, data); }
  listEnrichTargets(projectId: number, limit: number): filesStructural.EnrichTarget[] { return filesStructural.listEnrichTargets(this.idx(projectId), projectId, limit); }
  listSemanticStalePaths(projectId: number, limit?: number): string[] { return filesStructural.listSemanticStalePaths(this.idx(projectId), projectId, limit); }
  countSemanticStale(projectId: number): number { return filesStructural.countSemanticStale(this.idx(projectId), projectId); }
  upsertFileContent(fileId: number, content: string, sizeBytes?: number, projectId?: number): boolean { return fileContents.upsertContent(this.idx(projectId), fileId, content, sizeBytes); }
  removeFileContent(fileId: number, projectId?: number): void { fileContents.removeContent(this.idx(projectId), fileId); }
  searchFileContents(projectId: number, match: string, limit?: number): fileContents.ContentMatch[] { return fileContents.searchContent(this.idx(projectId), projectId, match, limit); }
  missingContentFiles(projectId: number, limit?: number): Array<{ id: number; path: string }> { return fileContents.missingContentFiles(this.idx(projectId), projectId, limit); }
  countFileContents(projectId: number): number { return fileContents.countContent(this.idx(projectId), projectId); }

  // ─── Symbols ────────────────────────────────────────────────────
  upsertSymbols(projectId: number, fileId: number, filePath: string, syms: LLMSymbol[]): void { symbols.upsert(this.idx(projectId), projectId, fileId, filePath, syms); }
  getSymbolById(id: number, projectId?: number): DBSymbol | undefined { return symbols.getById(this.idx(projectId), id); }
  getSymbolsByFile(projectId: number, filePath: string): DBSymbol[] { return symbols.getByFile(this.idx(projectId), projectId, filePath); }
  /** Preferred entry for pinning to an exact symbol across re-indexes. */
  findSymbolByStableId(projectId: number, stableId: string): DBSymbol | undefined { return symbols.findByStableId(this.idx(projectId), projectId, stableId); }
  findSymbolByName(projectId: number, name: string, opts?: symbols.FindSymbolOptions): DBSymbol | undefined { return symbols.findByName(this.idx(projectId), projectId, name, opts); }
  findSymbolsByName(projectId: number, name: string, opts?: symbols.FindSymbolsOptions): DBSymbol[] { return symbols.findManyByName(this.idx(projectId), projectId, name, opts); }
  getClassMembers(parentName: string, projectId: number): DBSymbol[] { return symbols.classMembers(this.idx(projectId), parentName, projectId); }
  listAllSymbols(projectId: number): DBSymbol[] { return symbols.listAll(this.idx(projectId), projectId); }
  searchSymbols(projectId: number, query: string, limit: number = 20): DBSymbol[] { return symbols.search(this.idx(projectId), projectId, query, limit); }
  /** Identifier-prefix completion (b-tree range scan — see symbols.searchByPrefix). */
  searchSymbolsByPrefix(projectId: number, prefix: string, limit: number = 50, opts?: { exportedOnly?: boolean }): DBSymbol[] { return symbols.searchByPrefix(this.idx(projectId), projectId, prefix, limit, opts); }
  listSymbolsByKind(projectId: number, kind: string, limit: number = 50): DBSymbol[] { return symbols.listByKind(this.idx(projectId), projectId, kind, limit); }

  // ─── Symbol References & Relations ──────────────────────────────
  upsertSymbolReferences(projectId: number, fileId: number, filePath: string, references: symbolRelations.SymbolReferenceInput[]): void { symbolRelations.upsertReferences(this.idx(projectId), projectId, fileId, filePath, references); }
  getSymbolReferences(symbolId: number, projectId?: number): DBSymbolReference[] { return symbolRelations.getReferences(this.idx(projectId), symbolId); }
  getSymbolCallers(projectId: number, symbolName: string): DBSymbolReference[] { return symbolRelations.getCallers(this.idx(projectId), projectId, symbolName); }
  getSymbolRelations(symbolId: number, projectId?: number): DBSymbolRelation[] { return symbolRelations.getRelations(this.idx(projectId), symbolId); }
  getImplementors(projectId: number, interfaceName: string): DBSymbol[] { return symbolRelations.getImplementors(this.idx(projectId), projectId, interfaceName); }
  getSubclasses(projectId: number, className: string): DBSymbol[] { return symbolRelations.getSubclasses(this.idx(projectId), projectId, className); }
  getSymbolHierarchy(projectId: number, symbolName: string): symbolRelations.SymbolHierarchy { return symbolRelations.getHierarchy(this.idx(projectId), projectId, symbolName); }
  traceSymbolUsage(projectId: number, symbolName: string, maxDepth: number = 3): symbolRelations.UsageTraceResult { return symbolRelations.traceUsage(this.idx(projectId), projectId, symbolName, maxDepth); }

  // ─── Runs ───────────────────────────────────────────────────────
  // Index-run provenance + stats stay CENTRAL (faithful run history; FK parent
  // of `costs`). The `projectId` params are kept for call-site compatibility but
  // routing is intentionally central.
  startRun(projectId: number, provider?: string, model?: string, kind?: RunKind): number { return runs.start(this.db, projectId, provider, model, kind); }
  finishRun(runId: number, data: runs.FinishRunData, _projectId?: number): void { runs.finish(this.db, runId, data); }
  getRun(id: number, _projectId?: number): IndexRun | undefined { return runs.get(this.db, id); }
  getRuns(projectId: number, limit: number = 20): IndexRun[] { return runs.list(this.db, projectId, limit); }

  // ─── Snapshots ──────────────────────────────────────────────────
  createSnapshot(projectId: number, data: snapshots.CreateSnapshotData): ContextSnapshot { return snapshots.create(this.db, projectId, data); }
  markSnapshotAccessed(ids: number[]): void { snapshots.markAccessed(this.db, ids); }
  /** Per-project memory toggle (migration 115). Default ON. */
  getProjectMemoryEnabled(projectId: number): boolean {
    const row = this.db.prepare('SELECT memory_enabled FROM projects WHERE id = ?')
      .get(projectId) as { memory_enabled?: number } | undefined;
    return row?.memory_enabled !== 0;
  }
  setProjectMemoryEnabled(projectId: number, enabled: boolean): void {
    this.db.prepare('UPDATE projects SET memory_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, projectId);
  }
  setSnapshotFiles(snapshotId: number, projectId: number, filePaths: string[]): { inserted: number; skipped: string[] } { return snapshots.setFiles(this.db, snapshotId, projectId, filePaths); }
  getStaleSnapshotFiles(snapshotId: number, projectId: number): string[] { return snapshots.getStaleFiles(this.db, snapshotId, projectId); }
  getStaleSnapshotFilesBatch(ids: number[], projectId: number): Map<number, { stale: string[]; total: number }> { return snapshots.getStaleFilesBatch(this.db, ids, projectId); }
  getSnapshotFiles(snapshotId: number): string[] { return snapshots.getFiles(this.db, snapshotId); }
  updateSnapshot(id: number, updates: snapshots.UpdateSnapshotData): void { snapshots.update(this.db, id, updates); }
  updateSnapshotEmbeddingHash(id: number, hash: string): void { snapshots.updateEmbeddingHash(this.db, id, hash); }
  listSnapshotsMissingEmbedding(projectId?: number): ContextSnapshot[] { return snapshots.listMissingEmbedding(this.db, projectId); }
  countSnapshots(projectId: number): number { return snapshots.count(this.db, projectId); }
  countSnapshotVectors(projectId: number): number { return snapshots.countVectors(this.db, projectId); }
  deleteSnapshot(id: number): void { snapshots.del(this.db, id); }
  getSnapshotById(id: number): ContextSnapshot | undefined { return snapshots.getById(this.db, id); }
  listSnapshots(projectId: number, category?: SnapshotCategory): ContextSnapshot[] { return snapshots.list(this.db, projectId, category); }
  listMemoryIndex(projectId: number, limit = 12): snapshots.MemoryIndexEntry[] { return snapshots.listMemoryIndex(this.db, projectId, limit); }
  searchSnapshots(projectId: number, query: string): ContextSnapshot[] { return snapshots.search(this.db, projectId, query); }
  getSnapshotHistory(snapshotId: number): SnapshotVersion[] { return snapshots.getHistory(this.db, snapshotId); }
  // ─── Snapshot archive / merge (migration 146, memory consolidator) ──
  archiveSnapshot(id: number, reason: string): void { snapshotsArchive.archive(this.db, id, reason); }
  unarchiveSnapshot(id: number): void { snapshotsArchive.unarchive(this.db, id); }
  unionSnapshotFiles(winnerId: number, loserIds: number[]): void { snapshotsArchive.unionFiles(this.db, winnerId, loserIds); }
  setSnapshotAccessStats(id: number, accessCount: number, lastAccessedAt: string | null): void { snapshotsArchive.setAccessStats(this.db, id, accessCount, lastAccessedAt); }
  countArchivedSnapshots(projectId: number): number { return snapshotsArchive.countArchived(this.db, projectId); }
  listArchivedSnapshots(projectId: number, limit = 50): ContextSnapshot[] { return snapshotsArchive.listArchived(this.db, projectId, limit); }
  listConsolidationCandidates(idleSeconds: number, limit: number): memoryConsolidation.ConsolidationCandidate[] { return memoryConsolidation.listConsolidationCandidates(this.db, idleSeconds, limit); }

  // ─── Memory distillation diagnostics (migration 136) ────────────
  insertMemoryDistillLog(projectId: number, entry: memoryDistillLog.MemoryDistillLogEntry): void { memoryDistillLog.insert(this.db, projectId, entry); }
  latestMemoryDistill(projectId: number): memoryDistillLog.MemoryDistillLogRow | null { return memoryDistillLog.latestForProject(this.db, projectId); }
  recentMemoryDistills(projectId: number, limit = 20): memoryDistillLog.MemoryDistillLogRow[] { return memoryDistillLog.recentForProject(this.db, projectId, limit); }
  countMemoryByCategory(projectId: number): Record<string, number> { return memoryDistillLog.countSnapshotsByCategory(this.db, projectId); }
  countMemoryBySource(projectId: number): Record<string, number> { return memoryDistillLog.countSnapshotsBySource(this.db, projectId); }

  // ─── Costs ──────────────────────────────────────────────────────
  // TELEMETRY/STATS stay CENTRAL (not per-project) so platform-wide usage
  // statistics remain faithful — `costs` is small, FK-linked to `runs`, and not
  // the write-contention source (that's files/symbols/embeddings). See plan §4.
  insertCost(data: costs.InsertCostData): void { costs.insert(this.db, data); }
  getCostSummary(projectId: number, since?: string): CostSummary { return costs.projectSummary(this.db, projectId, since); }
  getGlobalCostSummary(since?: string): CostSummary { return costs.globalSummary(this.db, since); }
  getRunCostSummary(runId: number): costs.RunCostSummary { return costs.runSummary(this.db, runId); }

  // ─── Webhooks ───────────────────────────────────────────────────
  createWebhook(data: webhooks.CreateWebhookData): Webhook { return webhooks.create(this.db, data); }
  listWebhooks(projectId?: number): Webhook[] { return webhooks.list(this.db, projectId); }
  deleteWebhook(id: number): void { webhooks.del(this.db, id); }
  getWebhooksForEvent(projectId: number, event: string): Webhook[] { return webhooks.forEvent(this.db, projectId, event); }
  updateWebhookStatus(id: number, statusCode: number): void { webhooks.updateStatus(this.db, id, statusCode); }

  // ─── Vector IDs ─────────────────────────────────────────────────
  saveVectorIds(projectId: number, vecs: vectors.VectorIdInput[]): void { vectors.save(this.idx(projectId), projectId, vecs); }
  getVectorIdsByProject(projectId: number): VectorIdRecord[] { return vectors.listByProject(this.idx(projectId), projectId); }
  deleteVectorIdsByProject(projectId: number): void { vectors.delByProject(this.idx(projectId), projectId); }
  deleteVectorIdsByFile(projectId: number, filePath: string): string[] { return vectors.delByFile(this.idx(projectId), projectId, filePath); }
  getVectorIdStats(projectId: number): { total: number; byType: Record<string, number> } { return vectors.stats(this.idx(projectId), projectId); }
  snapshotVectorIdsForProject(projectId: number): string[] { return vectors.snapshotForProject(this.idx(projectId), projectId); }
  getOrphanVectorIds(projectId: number): Array<{ vector_id: string; file_path: string | null; type: string }> { return vectors.listOrphans(this.idx(projectId), projectId); }
  deleteVectorIdRows(projectId: number, vectorIds: string[]): number { return vectors.deleteRows(this.idx(projectId), projectId, vectorIds); }
  dedupVectorIds(projectId?: number): number { return vectors.dedup(this.idx(projectId), projectId); }
  countPendingVectorDeletes(): number { return vectors.countPendingDeletes(this.db); }
  enqueuePendingVectorDeletes(rows: vectors.PendingDeleteInput[]): number { return vectors.enqueuePendingDeletes(this.db, rows); }
  takePendingVectorDeletes(limit = 5000): Array<{ id: number; vector_id: string; project_name: string | null }> { return vectors.takePendingDeletes(this.db, limit); }
  deletePendingVectorDeletesByIds(ids: number[]): number { return vectors.deletePendingByIds(this.db, ids); }

  // ─── Embedding diagnostics & hashes ─────────────────────────────
  // Embedding hashes live on files/symbols rows → route by project. The bare-id
  // setters/getters (full semantic pipeline, not structural) take an optional
  // projectId; thread it from the embedder when routing those is enabled.
  sampleEmbeddedFiles(projectId: number, limit = 5): Array<{ id: number; path: string; embedding_hash: string }> { return embeddings.sampleEmbeddedFiles(this.idx(projectId), projectId, limit); }
  sampleNotEmbeddedFiles(projectId: number, limit = 5): Array<{ id: number; path: string }> { return embeddings.sampleNotEmbeddedFiles(this.idx(projectId), projectId, limit); }
  getFileEmbeddingHashes(fileIds: number[], projectId?: number): Map<number, string | null> { return embeddings.getFileHashes(this.idx(projectId), fileIds); }
  setFileEmbeddingHash(fileId: number, hash: string, projectId?: number): void { embeddings.setFileHash(this.idx(projectId), fileId, hash); }
  getFileStructureHash(projectId: number, path: string): string | null { return embeddings.getFileStructureHash(this.idx(projectId), projectId, path); }
  setFileStructureHash(fileId: number, hash: string, projectId?: number): void { embeddings.setFileStructureHash(this.idx(projectId), fileId, hash); }
  getFileStructureEmbedding(projectId: number, path: string): Float32Array | null { return embeddings.getFileStructureEmbedding(this.idx(projectId), projectId, path); }
  setFileStructureEmbedding(fileId: number, embedding: Float32Array, projectId?: number): void { embeddings.setFileStructureEmbedding(this.idx(projectId), fileId, embedding); }
  getSymbolEmbeddingHashes(symbolIds: number[], projectId?: number): Map<number, { sig: string | null; body: string | null }> { return embeddings.getSymbolHashes(this.idx(projectId), symbolIds); }
  setSymbolEmbeddingHash(symbolId: number, hash: string, kind: 'sig' | 'body', projectId?: number): void { embeddings.setSymbolHash(this.idx(projectId), symbolId, hash, kind); }
  getEmbeddingCoverage(projectId: number): embeddings.EmbeddingCoverage { return embeddings.coverage(this.idx(projectId), projectId); }
  /** Null all embedding hashes for a project → next index re-embeds everything. */
  clearEmbeddingHashes(projectId: number): void { embeddings.clearHashes(this.idx(projectId), projectId); }
  /** Embedding model/backend the project was last indexed with (migration 113). */
  getProjectEmbeddingFingerprint(projectId: number): string | null {
    const row = this.db.prepare('SELECT embedding_fingerprint FROM projects WHERE id = ?')
      .get(projectId) as { embedding_fingerprint: string | null } | undefined;
    return row?.embedding_fingerprint ?? null;
  }
  setProjectEmbeddingFingerprint(projectId: number, fingerprint: string): void {
    this.db.prepare('UPDATE projects SET embedding_fingerprint = ? WHERE id = ?').run(fingerprint, projectId);
  }

  // ─── Models Cache ───────────────────────────────────────────────
  getCachedModels(provider: string): DiscoveredModel[] | null { return modelsCache.get(this.db, provider); }
  setCachedModels(provider: string, models: DiscoveredModel[]): void { modelsCache.set(this.db, provider, models); }

  // ─── Stats & Architecture ───────────────────────────────────────
  /**
   * Project stats (file/symbol counts, languages, sizes). The full scan is
   * 50-200ms on a large project and runs SYNCHRONOUSLY on the main thread, so
   * the dashboard path is served from a short-TTL cache to stop it freezing
   * every screen on open. `{ fresh: true }` bypasses + refreshes the cache —
   * REQUIRED for the indexer, which feeds this result straight into the
   * denormalized `projects.file_count` write (a stale read would persist a
   * wrong count). Display/guard callers use the default cached path.
   */
  getStats(projectId: number, opts?: { fresh?: boolean }): ProjectStats {
    const key = `stats:${projectId}`;
    const compute = (): ProjectStats =>
      stats.projectStats(this.idx(projectId), this.db, projectId, this.getProject(projectId));
    if (opts?.fresh) {
      const value = compute();
      this.readCache.set(key, value);
      return value;
    }
    return this.readCache.get(key, STATS_CACHE_TTL_MS, compute);
  }
  listConcepts(projectId: number): Array<{ concept: string; count: number }> { return stats.listConcepts(this.idx(projectId), projectId); }
  getFilesByConcept(projectId: number, concept: string): DBFile[] { return stats.getFilesByConcept(this.idx(projectId), projectId, concept); }
  // `runs` stays CENTRAL (stats) — read the run ids from there, not the project DB.
  getLastTwoRunIds(projectId: number): [number, number] | null { return stats.getLastTwoRunIds(this.db, projectId); }
  getFilesByLayer(projectId: number, layer: string): DBFile[] { return stats.getFilesByLayer(this.idx(projectId), projectId, layer); }
  getArchitectureOverview(projectId: number): Array<{ layer: string; count: number }> { return stats.getArchitectureOverview(this.idx(projectId), projectId); }

  // ─── Dependencies ───────────────────────────────────────────────
  upsertFileDependencies(projectId: number, sourceFileId: number, sourceFilePath: string, internalDeps: string[], externalDeps: string[]): void {
    deps.upsert(this.idx(projectId), projectId, sourceFileId, sourceFilePath, internalDeps, externalDeps, this.getAliases(projectId));
  }
  getDependencies(fileId: number, projectId?: number): DBFileDependency[] { return deps.getDependencies(this.idx(projectId), fileId); }
  getDependents(projectId: number, fileId: number): DBFileDependent[] { return deps.getDependents(this.idx(projectId), projectId, fileId); }
  getCircularDeps(projectId: number): Array<{ path_a: string; path_b: string }> { return deps.getCircular(this.idx(projectId), projectId); }
  getTopHubs(projectId: number, limit: number): Array<{ path: string; dependents: number }> { return deps.getTopHubs(this.idx(projectId), projectId, limit); }
  /** Invalidate alias cache (e.g. after re-index when tsconfig may have changed). */
  clearAliasCache(projectId?: number): void {
    if (projectId === undefined) this.aliasCache.clear();
    else this.aliasCache.delete(projectId);
  }

  // ─── Maintenance / Hygiene ──────────────────────────────────────
  getProjectsHygiene(): maintenance.ProjectHygieneRow[] { return maintenance.listProjectsHygiene(this.db); }
  getFileIndegrees(projectId: number): Map<string, number> { return maintenance.getFileIndegrees(this.idx(projectId), projectId); }
  getProjectTierBreakdown(): Array<{ project_id: number; tier: string; count: number }> { return maintenance.getProjectTierBreakdown(this.db); }
  normalizeFileLanguages(projectId?: number): number { return maintenance.normalizeFileLanguages(this.idx(projectId), projectId); }
  // `runs` stays CENTRAL (stats) — stale-run marking operates on the central runs.
  markStaleRuns(olderThanHours = 2, projectId?: number): number { return maintenance.markStaleRuns(this.db, olderThanHours, projectId); }
  setProjectPendingVectorGc(projectId: number, pending: boolean): void { maintenance.setProjectPendingVectorGc(this.db, projectId, pending); }

  private getAliases(projectId: number): PathAlias[] {
    const cached = this.aliasCache.get(projectId);
    if (cached) return cached;
    const project = this.getProject(projectId);
    const aliases = project ? loadTsconfigPathAliases(project.root_path) : [];
    this.aliasCache.set(projectId, aliases);
    return aliases;
  }
}
