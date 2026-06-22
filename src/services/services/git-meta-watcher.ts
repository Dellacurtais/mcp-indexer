import { watch, type FSWatcher } from 'chokidar';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Watches a project's `.git` metadata (HEAD + refs + sequencer state) so the
 * app can react to branch switches — whether triggered in-app or by an
 * external `git checkout` in a terminal. The working-tree watcher
 * (FileWatcherService) deliberately ignores `.git/**`; this is its sibling for
 * the git-identity signal it can't see.
 *
 * Only the cheap/relevant entries are watched: `objects/`, `logs/`, `index`
 * and lock files are noise and are ignored so we never descend the object DB.
 */

export type GitMetaChange = 'head' | 'ref' | 'sequencer';

export interface GitMetaEvent {
  /** Current branch name, or null when detached / unreadable. */
  branch: string | null;
  detached: boolean;
  /** Distinct kinds of git-dir change seen in this debounced batch. */
  changed: GitMetaChange[];
}

export interface GitMetaWatcherEvents {
  onChange(event: GitMetaEvent): void | Promise<void>;
}

/** `<root>/.git` is usually a dir; for worktrees/submodules it's a file
 *  pointing at the real gitdir (`gitdir: …`). Returns null when there's no repo.
 *  Worktree limitation: we watch the per-worktree gitdir (which holds HEAD, so
 *  branch switches — the primary signal — still fire), but its refs/ + packed-refs
 *  live in the shared common dir, so ref-only updates (a commit/fetch without a
 *  HEAD change) aren't detected for worktrees; those self-heal on the next
 *  HEAD-touching event or the file-tree's periodic git-status poll. */
function resolveGitDir(rootPath: string): string | null {
  const dotGit = join(rootPath, '.git');
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  if (st.isFile()) {
    try {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
      return m ? resolve(rootPath, m[1].trim()) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** `.git/HEAD` → branch name, or detached when it holds a raw commit sha. The
 *  ambiguous {branch:null, detached:false} return means "couldn't determine"
 *  (unreadable mid-write / empty) — startWatching falls back to the last known
 *  state for that case so a transient read never emits a false "detached". */
function readHead(gitDir: string): { branch: string | null; detached: boolean } {
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return { branch: ref[1].trim(), detached: false };
    if (/^[0-9a-f]{7,40}$/i.test(head)) return { branch: null, detached: true };
  } catch {
    /* unreadable mid-write — fall back to the last known branch */
  }
  return { branch: null, detached: false };
}

/** gitDir-relative POSIX path of an absolute chokidar path. */
function relInGitDir(absPath: string, gitDir: string): string {
  return absPath.slice(gitDir.length).replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Object DB, reflog, index and locks: high-churn or huge, never branch-relevant. */
function isNoise(absPath: string, gitDir: string): boolean {
  const rel = relInGitDir(absPath, gitDir);
  if (rel === '') return false; // the gitDir root itself
  if (rel.endsWith('.lock')) return true;
  if (rel === 'index' || rel === 'FETCH_HEAD' || rel === 'COMMIT_EDITMSG' || rel === 'ORIG_HEAD') return true;
  const top = rel.split('/')[0];
  // `fsmonitor--daemon/` holds git's builtin filesystem-monitor IPC socket +
  // cookie files, which it rewrites constantly — prune so we never open handles on it.
  return (
    top === 'objects' || top === 'logs' || top === 'lfs' || top === 'hooks' ||
    top === 'info' || top === 'modules' || top === 'fsmonitor--daemon'
  );
}

/** Map a changed git-dir entry to the kind of git event it represents. */
function classify(absPath: string, gitDir: string): GitMetaChange | null {
  const rel = relInGitDir(absPath, gitDir);
  if (rel === 'HEAD') return 'head';
  if (rel === 'packed-refs' || rel.startsWith('refs/')) return 'ref';
  if (
    rel === 'MERGE_HEAD' || rel === 'CHERRY_PICK_HEAD' || rel === 'REVERT_HEAD' || rel === 'REBASE_HEAD' ||
    rel.startsWith('rebase-merge/') || rel.startsWith('rebase-apply/') || rel.startsWith('sequencer/')
  ) {
    return 'sequencer';
  }
  return null;
}

const DEBOUNCE_MS = 250;

export class GitMetaWatcher {
  private watchers = new Map<number, FSWatcher>();
  private pending = new Map<number, Set<GitMetaChange>>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Last successfully-determined HEAD per project — used to mask transient reads. */
  private lastHead = new Map<number, { branch: string | null; detached: boolean }>();

  /** Arm the watcher for one project. No-op when the project isn't a git repo. */
  startWatching(projectId: number, rootPath: string, events: GitMetaWatcherEvents): void {
    if (this.watchers.has(projectId)) return;
    const gitDir = resolveGitDir(rootPath);
    if (!gitDir) return;
    this.pending.set(projectId, new Set());
    // Baseline for the transient-read fallback above.
    this.lastHead.set(projectId, readHead(gitDir));

    const watcher = watch(gitDir, {
      persistent: true,
      ignoreInitial: true,
      ignored: (p: string) => isNoise(p, gitDir),
      // HEAD/refs are written via write-then-rename; a short settle avoids
      // reading a half-written file before we re-read it ourselves.
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    const onEvent = (filePath: string) => {
      const kind = classify(filePath, gitDir);
      if (!kind) return;
      this.pending.get(projectId)!.add(kind);
      const existing = this.timers.get(projectId);
      if (existing) clearTimeout(existing);
      // Coalesce: a checkout touches HEAD (+ refs) in a burst — fire once.
      const timer = setTimeout(() => {
        const set = this.pending.get(projectId);
        if (!set || set.size === 0) return;
        const changed = Array.from(set);
        set.clear();
        let { branch, detached } = readHead(gitDir);
        // Ambiguous read (mid-write / unreadable) → keep the last known HEAD so
        // we don't emit a false "detached" branch:null that the UI would toast.
        if (branch === null && !detached) {
          const last = this.lastHead.get(projectId);
          if (last) ({ branch, detached } = last);
        }
        this.lastHead.set(projectId, { branch, detached });
        void events.onChange({ branch, detached, changed });
      }, DEBOUNCE_MS);
      this.timers.set(projectId, timer);
    };

    watcher.on('add', onEvent);
    watcher.on('change', onEvent);
    watcher.on('unlink', onEvent);
    this.watchers.set(projectId, watcher);
  }

  async stopWatching(projectId: number): Promise<void> {
    const watcher = this.watchers.get(projectId);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(projectId);
    }
    const timer = this.timers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(projectId);
    }
    this.pending.delete(projectId);
    this.lastHead.delete(projectId);
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.watchers.keys()).map((id) => this.stopWatching(id)));
  }

  isWatching(projectId: number): boolean {
    return this.watchers.has(projectId);
  }

  /** Current branch snapshot (changed:[]) — used to seed a new subscriber so it
   *  can tell a real switch from its first frame. Null when not a git repo. */
  readCurrent(rootPath: string): GitMetaEvent | null {
    const gitDir = resolveGitDir(rootPath);
    if (!gitDir) return null;
    const { branch, detached } = readHead(gitDir);
    return { branch, detached, changed: [] };
  }
}
