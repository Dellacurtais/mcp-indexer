import { watch, type FSWatcher } from 'chokidar';

export interface WatcherFileEvent {
  /** Absolute path as emitted by chokidar (backslashes on win32 — callers normalize). */
  path: string;
  /** add/change/addDir → upsert; unlink/unlinkDir → delete. Latest event per path wins. */
  kind: 'upsert' | 'delete';
  /** Directory event (addDir/unlinkDir) — consumed by the UI fs-events stream, not the indexer. */
  isDir?: boolean;
}

export interface WatcherEvents {
  onFileChanged(events: WatcherFileEvent[]): void | Promise<void>;
}

export interface WatcherOptions {
  rootPath: string;
  debounce: number;
  ignorePatterns?: string[];
}

export class FileWatcherService {
  private watchers = new Map<number, FSWatcher>();
  private pendingChanges = new Map<number, Map<string, { kind: WatcherFileEvent['kind']; isDir: boolean }>>();
  private debounceTimers = new Map<number, ReturnType<typeof setTimeout>>();

  startWatching(projectId: number, options: WatcherOptions, events: WatcherEvents): void {
    if (this.watchers.has(projectId)) return;

    const ignored = [
      '**/node_modules/**',
      '**/.git/**',
      // Indexer's private working dir (trash bin + `.tmp` scratch the
      // doc-indexer writes-then-deletes). Watching it floods the pipeline
      // with add/unlink for ephemeral files and feeds phantom paths to the
      // LSP — see ts-service isIndexerInternalPath.
      '**/.mcp-indexer/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      // Windows system / special folders that throw EPERM/EACCES when watched
      // (relevant if a root accidentally points high, e.g. the home dir).
      '**/AppData/**',
      '**/$Recycle.Bin/**',
      '**/System Volume Information/**',
      '**/Ambiente de Impressão/**',
      ...(options.ignorePatterns ?? []),
    ];

    const watcher = watch(options.rootPath, {
      persistent: true,
      ignoreInitial: true,
      ignored,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    // CRITICAL: chokidar emits an 'error' event (e.g. EPERM/EACCES on an
    // unwatchable subdir). Without a handler, Node turns an unhandled 'error'
    // on an EventEmitter into an uncaught exception that crashes the process.
    // Log and ignore — one bad path must never take down the server.
    watcher.on('error', (err) => {
      const e = err as { code?: string; path?: string; message?: string };
      process.stderr.write(
        `[code-context] watcher: skipping unwatchable path (${e.code ?? 'error'})${e.path ? ` ${e.path}` : ''}\n`,
      );
    });

    this.pendingChanges.set(projectId, new Map());

    const handleChange = (kind: WatcherFileEvent['kind'], isDir = false) => (filePath: string) => {
      const pending = this.pendingChanges.get(projectId)!;
      // Key carries the dir flag so a file and a dir at the same path (rare
      // rename races) don't clobber each other's semantics.
      pending.set(filePath, { kind, isDir }); // unlink after change collapses to delete

      // Reset debounce timer
      const existingTimer = this.debounceTimers.get(projectId);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(async () => {
        const batch = Array.from(pending, ([path, v]) => ({ path, kind: v.kind, isDir: v.isDir }));
        pending.clear();
        if (batch.length > 0) {
          await events.onFileChanged(batch);
        }
      }, options.debounce);

      this.debounceTimers.set(projectId, timer);
    };

    watcher.on('add', handleChange('upsert'));
    watcher.on('change', handleChange('upsert'));
    watcher.on('unlink', handleChange('delete'));
    watcher.on('addDir', handleChange('upsert', true));
    watcher.on('unlinkDir', handleChange('delete', true));

    this.watchers.set(projectId, watcher);
  }

  async stopWatching(projectId: number): Promise<void> {
    const watcher = this.watchers.get(projectId);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(projectId);
    }

    const timer = this.debounceTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(projectId);
    }

    this.pendingChanges.delete(projectId);
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.watchers.keys());
    await Promise.all(ids.map(id => this.stopWatching(id)));
  }

  isWatching(projectId: number): boolean {
    return this.watchers.has(projectId);
  }

  listWatching(): number[] {
    return Array.from(this.watchers.keys());
  }
}
