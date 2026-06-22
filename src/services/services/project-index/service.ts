import { isAbsolute, relative } from 'node:path';
import type { CodeIndexDB } from '@ctx/store/db.js';
import { FileWatcherService, type WatcherFileEvent } from '../watcher.js';
import { GitMetaWatcher, type GitMetaEvent } from '../git-meta-watcher.js';
import { KeyedMutex } from './project-mutex.js';
import { ProjectIndexStatusStore } from './status-store.js';
import { DirtyQueue } from './dirty-queue.js';
import {
  readProjectIndexSettings,
  type ActiveIndexRun,
  type DirtyEvent,
  type FsEvent,
  type ProjectIndexSettings,
  type ProjectIndexStatus,
  type StructuralExecutor,
  type StructuralProgressFrame,
} from './types.js';

export type EnsureFreshReason = 'open' | 'scaffold' | 'session' | 'manual' | 'branch';

const ENSURE_COOLDOWN_MS = 30_000;
const DRAIN_BATCH = 200;
const PROGRESS_MIN_INTERVAL_MS = 150;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Chokidar absolute path → index-form relative path; null when outside the root (or cross-drive). */
function toRelPath(root: string, absPath: string): string | null {
  const rel = relative(root, absPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

/**
 * IntelliJ-style auto indexing: "project opened" triggers an idempotent
 * structural run; a chokidar watcher + dirty queue keep symbols/FTS fresh in
 * real time; everything per-project serializes on one mutex (structural run ×
 * incremental drain × manual full index). `ensureFresh` is the hot-path entry
 * (fired from GET /projects/:id) — memory-only checks, never awaits.
 */
export class ProjectIndexService {
  private mutex = new KeyedMutex<number>();
  private dirty = new DirtyQueue();
  private status: ProjectIndexStatusStore;
  private running = new Set<number>();
  private draining = new Set<number>();
  private lastEnsureAt = new Map<number, number>();
  private lastProgressAt = new Map<number, number>();
  /** Deferred-open timers (MCP_INDEX_OPEN_DELAY_MS) — cancelled when a run starts. */
  private pendingOpen = new Map<number, ReturnType<typeof setTimeout>>();
  /** Deferred heavy working-tree watcher start (MCP_WATCH_OPEN_DELAY_MS). */
  private fileWatchOpenTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Idle stop timers for recursive file watchers after the UI unsubscribes. */
  private fileWatchIdleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** MRU-first list of watched projects (LRU eviction beyond the cap). */
  private watchOrder: number[] = [];
  /** UI fs-events subscribers (live tree / tab reload), per project. */
  private fsListeners = new Map<number, Set<(events: FsEvent[]) => void>>();
  /** UI git-meta subscribers (branch chip / git window refresh), per project. */
  private gitMetaListeners = new Map<number, Set<(event: GitMetaEvent) => void>>();
  private disposed = false;

  constructor(
    private db: CodeIndexDB,
    private executor: StructuralExecutor,
    private watcher: FileWatcherService = new FileWatcherService(),
    private settings: () => ProjectIndexSettings = readProjectIndexSettings,
    private gitMetaWatcher: GitMetaWatcher = new GitMetaWatcher(),
  ) {
    this.status = new ProjectIndexStatusStore(db);
  }

  /** Late-bound upgrade: in-process fallback → indexer worker client. */
  setExecutor(executor: StructuralExecutor): void {
    this.executor = executor;
  }

  /** Fire-and-forget "project became active". Cheap and re-entrant. */
  ensureFresh(projectId: number, reason: EnsureFreshReason): void {
    if (this.disposed) return;
    const s = this.settings();
    if (!s.autoIndex && reason !== 'manual') return;
    if (this.running.has(projectId)) return;
    const last = this.lastEnsureAt.get(projectId) ?? 0;
    // 'branch' bypasses the cooldown like 'manual' (a fresh checkout must
    // re-index now), but stays gated by autoIndex above.
    if (reason !== 'manual' && reason !== 'branch' && Date.now() - last < ENSURE_COOLDOWN_MS) {
      return; // fresh enough — the watcher is keeping it current
    }
    this.lastEnsureAt.set(projectId, Date.now());
    // The cheap .git watcher starts on open so branch switches re-index.
    // The recursive working-tree watcher is delayed until the UI asks for
    // live fs events, keeping project mount off the hot path.
    this.ensureGitMetaWatching(projectId);

    const manual = reason === 'manual';
    const delay = manual ? 0 : s.openDelayMs;
    if (delay <= 0) {
      this.startStructuralRun(projectId, s, manual);
      return;
    }
    if (this.pendingOpen.has(projectId)) return; // already scheduled
    // Defer the CPU-bound run so the renderer paints the project screen
    // before the indexer worker pins a core. A manual trigger during the
    // window preempts — startStructuralRun cancels this timer.
    const t = setTimeout(() => {
      this.pendingOpen.delete(projectId);
      this.startStructuralRun(projectId, s, false);
    }, delay);
    t.unref?.();
    this.pendingOpen.set(projectId, t);
  }

  /** Kick the locked structural run + drain. Cancels any deferred-open timer. */
  private startStructuralRun(projectId: number, s: ProjectIndexSettings, manual: boolean): void {
    const pending = this.pendingOpen.get(projectId);
    if (pending) {
      clearTimeout(pending);
      this.pendingOpen.delete(projectId);
    }
    if (this.disposed || this.running.has(projectId)) return;
    this.running.add(projectId);
    void this.mutex
      .withLock(projectId, () => this.runStructural(projectId, s, manual))
      .catch((err) => this.status.setPhase(projectId, 'error', msg(err)))
      .finally(() => {
        this.running.delete(projectId);
        this.lastProgressAt.delete(projectId);
        this.scheduleDrain(projectId);
      });
  }

  /** Known changes (Monaco save/rename/delete, scaffold) — index-form rel paths. */
  markDirty(projectId: number, events: DirtyEvent[]): void {
    if (this.disposed || events.length === 0) return;
    this.dirty.add(projectId, events);
    this.status.setDirtyPending(projectId, this.dirty.size(projectId));
    // Every indexable change is also a UI-visible change — markDirty is the
    // single funnel (watcher + Monaco fast-path + scaffold), so publishing
    // here gives the live tree near-zero latency on editor saves.
    this.publishFsEvents(projectId, events.map((e) => ({ ...e, isDir: false })));
    this.scheduleDrain(projectId);
  }

  /** Live filesystem events for the UI. Subscribing arms the watcher. */
  subscribeFsEvents(projectId: number, fn: (events: FsEvent[]) => void): () => void {
    let set = this.fsListeners.get(projectId);
    if (!set) {
      set = new Set();
      this.fsListeners.set(projectId, set);
    }
    set.add(fn);
    const idle = this.fileWatchIdleTimers.get(projectId);
    if (idle) {
      clearTimeout(idle);
      this.fileWatchIdleTimers.delete(projectId);
    }
    this.ensureFileWatching(projectId, this.settings().watchOpenDelayMs);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) {
        this.fsListeners.delete(projectId);
        this.scheduleFileWatcherStop(projectId);
      }
    };
  }

  /** Manual publication for mutations the watcher can't see fast (mkdir). */
  publishFsEvents(projectId: number, events: FsEvent[]): void {
    if (events.length === 0) return;
    const set = this.fsListeners.get(projectId);
    if (!set) return;
    for (const fn of set) {
      try { fn(events); } catch { /* UI listeners never break indexing */ }
    }
  }

  /** Live git-metadata events for the UI (branch chip, git window). Subscribing arms the watcher. */
  subscribeGitMeta(projectId: number, fn: (event: GitMetaEvent) => void): () => void {
    let set = this.gitMetaListeners.get(projectId);
    if (!set) {
      set = new Set();
      this.gitMetaListeners.set(projectId, set);
    }
    set.add(fn);
    this.ensureGitMetaWatching(projectId);
    // Seed this subscriber with the current branch (changed:[]) so the UI can
    // distinguish a genuine switch (→ toast) from its first frame (→ just sync).
    const project = this.db.getProject(projectId);
    if (project?.root_path) {
      const seed = this.gitMetaWatcher.readCurrent(project.root_path);
      if (seed) { try { fn(seed); } catch { /* ignore */ } }
    }
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.gitMetaListeners.delete(projectId);
    };
  }

  private publishGitMeta(projectId: number, event: GitMetaEvent): void {
    const set = this.gitMetaListeners.get(projectId);
    if (!set) return;
    for (const fn of set) {
      try { fn(event); } catch { /* UI listeners never break the watcher */ }
    }
  }

  /** Branch switch (HEAD changed) → explicit re-index; any git-dir change → UI refresh. */
  private onGitMetaChange(projectId: number, event: GitMetaEvent): void {
    this.publishGitMeta(projectId, event);
    // HEAD change ⇒ branch switch ⇒ explicit structural pass. If a run is already
    // in flight ensureFresh drops this (no queue) — acceptable: the checkout's
    // working-tree deltas still flow through the file watcher → markDirty → drain,
    // so symbols/FTS catch up incrementally even when the structural pass is skipped.
    if (event.changed.includes('head')) this.ensureFresh(projectId, 'branch');
  }

  private touchWatchOrder(projectId: number, s: ProjectIndexSettings): void {
    this.watchOrder = [projectId, ...this.watchOrder.filter((id) => id !== projectId)];
    while (this.watchOrder.length > s.maxWatchedProjects) {
      void this.stopWatching(this.watchOrder[this.watchOrder.length - 1]);
    }
  }

  private ensureGitMetaWatching(projectId: number): void {
    if (this.disposed) return;
    const s = this.settings();
    if (!s.autoWatch && !s.autoIndex) return;
    this.touchWatchOrder(projectId, s);
    if (this.gitMetaWatcher.isWatching(projectId)) return;
    const project = this.db.getProject(projectId);
    if (!project?.root_path) return;
    this.gitMetaWatcher.startWatching(projectId, project.root_path, {
      onChange: (event) => this.onGitMetaChange(projectId, event),
    });
  }

  private ensureFileWatching(projectId: number, delayMs: number): void {
    if (this.disposed) return;
    const s = this.settings();
    if (!s.autoWatch || this.watcher.isWatching(projectId)) return;
    this.touchWatchOrder(projectId, s);
    if (this.fileWatchOpenTimers.has(projectId)) return;
    if (delayMs <= 0) {
      this.startFileWatchingNow(projectId);
      return;
    }
    const timer = setTimeout(() => {
      this.fileWatchOpenTimers.delete(projectId);
      if (this.disposed || !this.fsListeners.has(projectId) || this.watcher.isWatching(projectId)) return;
      this.startFileWatchingNow(projectId);
    }, delayMs);
    timer.unref?.();
    this.fileWatchOpenTimers.set(projectId, timer);
  }

  private startFileWatchingNow(projectId: number): void {
    if (this.disposed || this.watcher.isWatching(projectId)) return;
    const s = this.settings();
    if (!s.autoWatch || !this.fsListeners.has(projectId)) return;
    this.touchWatchOrder(projectId, s);
    const project = this.db.getProject(projectId);
    if (!project?.root_path) return;
    const root = project.root_path;
    this.watcher.startWatching(
      projectId,
      { rootPath: root, debounce: s.watchDebounceMs },
      { onFileChanged: (events) => this.onWatcherEvents(projectId, root, events) },
    );
    this.status.setWatcher(projectId, true);
  }

  private scheduleFileWatcherStop(projectId: number): void {
    const existing = this.fileWatchIdleTimers.get(projectId);
    if (existing) clearTimeout(existing);
    const pendingOpen = this.fileWatchOpenTimers.get(projectId);
    if (pendingOpen) {
      clearTimeout(pendingOpen);
      this.fileWatchOpenTimers.delete(projectId);
    }
    const idleMs = this.settings().watchIdleMs;
    if (idleMs <= 0) {
      void this.stopFileWatching(projectId);
      return;
    }
    const timer = setTimeout(() => {
      this.fileWatchIdleTimers.delete(projectId);
      if (!this.fsListeners.has(projectId)) void this.stopFileWatching(projectId);
    }, idleMs);
    timer.unref?.();
    this.fileWatchIdleTimers.set(projectId, timer);
  }

  private async stopFileWatching(projectId: number): Promise<void> {
    const openTimer = this.fileWatchOpenTimers.get(projectId);
    if (openTimer) {
      clearTimeout(openTimer);
      this.fileWatchOpenTimers.delete(projectId);
    }
    const idleTimer = this.fileWatchIdleTimers.get(projectId);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.fileWatchIdleTimers.delete(projectId);
    }
    await this.watcher.stopWatching(projectId);
    this.status.setWatcher(projectId, false);
  }

  async stopWatching(projectId: number): Promise<void> {
    this.watchOrder = this.watchOrder.filter((id) => id !== projectId);
    await this.stopFileWatching(projectId);
    await this.gitMetaWatcher.stopWatching(projectId);
    this.status.setWatcher(projectId, false);
  }

  getStatus(projectId: number): ProjectIndexStatus {
    return {
      ...this.status.get(projectId),
      dirtyPending: this.dirty.size(projectId),
      watcherActive: this.watcher.isWatching(projectId),
    };
  }

  subscribe(projectId: number, fn: (s: ProjectIndexStatus) => void): () => void {
    return this.status.subscribe(projectId, fn);
  }

  /**
   * Publish a live pass to the status store. The manual index/embeddings stream
   * handlers call this on each progress frame so the run shows up in the
   * main-process SoT — and therefore survives a renderer navigation (the
   * manual run no longer lives only in React state tied to the SSE fetch).
   */
  setActiveRun(projectId: number, run: Omit<ActiveIndexRun, 'startedAt'> & { startedAt?: number }): void {
    this.status.setActiveRun(projectId, run);
  }

  /** Settle status from the DB (clears the live pass) once a run ends. */
  refreshStatus(projectId: number): void {
    this.status.refreshFromDb(projectId);
  }

  /** Serialize arbitrary work (e.g. the manual FULL index) against this project. */
  withProjectLock<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
    return this.mutex.withLock(projectId, fn);
  }

  /** Full-index wrapper: lock + semantic_indexing phase + DB-derived settle. */
  withSemanticRun<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
    return this.mutex.withLock(projectId, async () => {
      this.status.setPhase(projectId, 'semantic_indexing');
      try {
        return await fn();
      } finally {
        this.status.refreshFromDb(projectId);
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const t of this.pendingOpen.values()) clearTimeout(t);
    for (const t of this.fileWatchOpenTimers.values()) clearTimeout(t);
    for (const t of this.fileWatchIdleTimers.values()) clearTimeout(t);
    this.pendingOpen.clear();
    this.fileWatchOpenTimers.clear();
    this.fileWatchIdleTimers.clear();
    await this.watcher.stopAll();
    await this.gitMetaWatcher.stopAll();
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async runStructural(projectId: number, s: ProjectIndexSettings, manual = false): Promise<void> {
    this.status.setPhase(projectId, 'scanning');
    const result = await this.executor.runStructuralIndex(projectId, {
      maxFiles: s.maxFiles,
      allowEmptyWipe: manual,
      onProgress: (p) => this.publishStructuralProgress(projectId, p),
    });
    if (result.aborted === 'too_large') {
      this.status.setPhase(projectId, 'too_large');
      return;
    }
    if (result.aborted === 'empty_scan') {
      this.status.setPhase(
        projectId,
        'error',
        'scan found 0 files — check the project root path and .gitignore/.mcpindexignore; a manual reindex overrides',
      );
      return;
    }
    this.status.refreshFromDb(projectId);
  }

  private onWatcherEvents(projectId: number, rootPath: string, events: WatcherFileEvent[]): void {
    const dirty: DirtyEvent[] = [];
    const dirEvents: FsEvent[] = [];
    for (const e of events) {
      const rel = toRelPath(rootPath, e.path);
      if (!rel) continue;
      if (e.isDir) dirEvents.push({ path: rel, kind: e.kind, isDir: true });
      else dirty.push({ path: rel, kind: e.kind });
    }
    // Dirs go straight to the UI stream (the indexer ignores them);
    // files flow through markDirty, which publishes + drains.
    this.publishFsEvents(projectId, dirEvents);
    this.markDirty(projectId, dirty);
  }

  private publishStructuralProgress(projectId: number, p: StructuralProgressFrame): void {
    const now = Date.now();
    const last = this.lastProgressAt.get(projectId) ?? 0;
    // A final frame (current reached a known total) always flushes; otherwise
    // coalesce. Scanning frames carry total 0 until the walk ends, so they ride
    // the time gate. Routing by phase keeps the chip on "Scanning…" with a live
    // count rather than jumping to "Indexing 0/0".
    const done = p.total > 0 && p.current >= p.total;
    if (!done && now - last < PROGRESS_MIN_INTERVAL_MS) return;
    this.lastProgressAt.set(projectId, now);
    if (p.phase === 'scanning') this.status.setScanProgress(projectId, p.current, p.total);
    else this.status.setProgress(projectId, p.current, p.total);
  }

  private scheduleDrain(projectId: number): void {
    if (this.disposed || this.draining.has(projectId) || this.dirty.size(projectId) === 0) return;
    this.draining.add(projectId);
    void this.mutex
      .withLock(projectId, async () => {
        while (this.dirty.size(projectId) > 0) {
          const batch = this.dirty.takeBatch(projectId, DRAIN_BATCH);
          if (batch.total === 0) break;
          if (batch.deletes.length > 0) await this.executor.removeFiles(projectId, batch.deletes);
          if (batch.upserts.length > 0) await this.executor.indexFiles(projectId, batch.upserts);
          this.status.setDirtyPending(projectId, this.dirty.size(projectId));
          if (this.dirty.size(projectId) > 0) await yieldToEventLoop();
        }
        this.status.refreshFromDb(projectId);
      })
      .catch((err) => console.warn(`[project-index] drain failed for project ${projectId}: ${msg(err)}`))
      .finally(() => {
        this.draining.delete(projectId);
        // Items that arrived between the loop exit and the flag reset.
        if (this.dirty.size(projectId) > 0) this.scheduleDrain(projectId);
      });
  }
}
