import type { CodeIndexDB } from '@ctx/store/db.js';
import type { ActiveIndexRun, ProjectIndexPhase, ProjectIndexStatus } from './types.js';

/** Phases that mean "a pass is in flight" — entering them keeps activeRun. */
const INDEXING_PHASES = new Set<ProjectIndexPhase>([
  'scanning',
  'structural_indexing',
  'semantic_indexing',
]);

type Listener = (s: ProjectIndexStatus) => void;

interface Entry {
  status: ProjectIndexStatus;
  hydrated: boolean;
  listeners: Set<Listener>;
}

/**
 * In-memory status per project, lazily hydrated from the DB row (the
 * persistent truth: structural_indexed_at / last_indexed / counters).
 * Phase transitions and progress are runtime-only; a restart re-derives
 * the resting phase from the DB.
 */
export class ProjectIndexStatusStore {
  private entries = new Map<number, Entry>();

  constructor(private db: CodeIndexDB) {}

  get(projectId: number): ProjectIndexStatus {
    return { ...this.entry(projectId).status };
  }

  subscribe(projectId: number, fn: Listener): () => void {
    const entry = this.entry(projectId);
    entry.listeners.add(fn);
    return () => entry.listeners.delete(fn);
  }

  setPhase(projectId: number, phase: ProjectIndexPhase, error?: string): void {
    // Entering a working phase keeps the live run visible; settling to a
    // resting/terminal phase clears it (clearActiveRun is the explicit clear).
    const clear = !INDEXING_PHASES.has(phase);
    this.patch(projectId, { phase, error, ...(clear ? { activeRun: undefined, progress: undefined } : {}) });
  }

  setProgress(projectId: number, current: number, total: number): void {
    this.setActiveRun(projectId, { kind: 'structural', current, total });
  }

  /**
   * Live "scanning" liveness — keeps `phase:'scanning'` (the frozen spinner
   * becomes a moving counter) WITHOUT flipping to structural_indexing the way
   * setProgress/setActiveRun do. `total` is 0 during the walk; the index phase
   * supplies real totals via setProgress afterwards.
   */
  setScanProgress(projectId: number, scanned: number, total: number): void {
    const prev = this.entry(projectId).status.activeRun;
    const startedAt = prev?.kind === 'structural' ? prev.startedAt : Date.now();
    this.patch(projectId, {
      phase: 'scanning',
      activeRun: { kind: 'structural', current: scanned, total, startedAt },
      progress: { current: scanned, total },
    });
  }

  /**
   * Publish the live pass. `progress` is kept in sync as the deprecated alias
   * the StatusBar chip reads. `startedAt` is preserved across frames of the
   * same kind so an elapsed-time readout stays stable.
   */
  setActiveRun(projectId: number, run: Omit<ActiveIndexRun, 'startedAt'> & { startedAt?: number }): void {
    const prev = this.entry(projectId).status.activeRun;
    const startedAt = run.startedAt ?? (prev?.kind === run.kind ? prev.startedAt : Date.now());
    this.patch(projectId, {
      activeRun: { ...run, startedAt },
      progress: { current: run.current, total: run.total },
      phase: run.kind === 'structural' ? 'structural_indexing' : 'semantic_indexing',
    });
  }

  clearActiveRun(projectId: number): void {
    this.patch(projectId, { activeRun: undefined, progress: undefined });
  }

  setWatcher(projectId: number, active: boolean): void {
    this.patch(projectId, { watcherActive: active });
  }

  setDirtyPending(projectId: number, dirtyPending: number): void {
    this.patch(projectId, { dirtyPending });
  }

  /**
   * Re-read counters + stamps from the DB and settle into the resting phase
   * (semantic_ready ⊃ structural_ready ⊃ none). Called after every run/drain.
   */
  refreshFromDb(projectId: number): void {
    const entry = this.entry(projectId);
    const fresh = this.derive(projectId);
    this.patch(projectId, {
      ...fresh,
      // Keep runtime-only bits.
      watcherActive: entry.status.watcherActive,
      dirtyPending: entry.status.dirtyPending,
      // The run is over — drop the live pass + its chip alias.
      activeRun: undefined,
      progress: undefined,
      error: undefined,
    });
  }

  private patch(projectId: number, partial: Partial<ProjectIndexStatus>): void {
    const entry = this.entry(projectId);
    entry.status = { ...entry.status, ...partial, projectId };
    for (const fn of entry.listeners) {
      try { fn({ ...entry.status }); } catch { /* listener errors never propagate */ }
    }
  }

  private entry(projectId: number): Entry {
    let entry = this.entries.get(projectId);
    if (!entry) {
      entry = {
        status: { watcherActive: false, dirtyPending: 0, ...this.derive(projectId) },
        hydrated: true,
        listeners: new Set(),
      };
      this.entries.set(projectId, entry);
    }
    return entry;
  }

  private derive(projectId: number): Omit<ProjectIndexStatus, 'watcherActive' | 'dirtyPending'> {
    const project = this.db.getProject(projectId);
    // A ready phase additionally requires actual rows — a stale/buggy stamp
    // over an empty index must never render "Symbols ready · 0 files".
    const hasRows = (project?.file_count ?? 0) > 0;
    const phase: ProjectIndexPhase = project?.last_indexed && hasRows
      ? 'semantic_ready'
      : project?.structural_indexed_at && hasRows
        ? 'structural_ready'
        : 'none';
    let semanticStaleCount = 0;
    try { semanticStaleCount = this.db.countSemanticStale(projectId); } catch { /* pre-migration DB */ }
    return {
      projectId,
      phase,
      fileCount: project?.file_count ?? 0,
      symbolCount: project?.symbol_count ?? 0,
      semanticStaleCount,
      lastStructuralAt: project?.structural_indexed_at ?? null,
      lastSemanticAt: project?.last_indexed ?? null,
    };
  }
}
