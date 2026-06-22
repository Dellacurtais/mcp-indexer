import type { DirtyEvent, DirtyKind } from './types.js';

/**
 * Per-project pending-change set for the incremental drain. Deduped by
 * path; a later event overwrites the kind (unlink after change = delete).
 * Paths are normalized to the index form (relative, forward slashes) by
 * the caller — this structure is transport-dumb.
 */
export class DirtyQueue {
  private byProject = new Map<number, Map<string, DirtyKind>>();

  add(projectId: number, events: DirtyEvent[]): void {
    if (events.length === 0) return;
    let map = this.byProject.get(projectId);
    if (!map) {
      map = new Map();
      this.byProject.set(projectId, map);
    }
    for (const e of events) map.set(e.path, e.kind);
  }

  size(projectId: number): number {
    return this.byProject.get(projectId)?.size ?? 0;
  }

  /**
   * Remove and return up to `max` entries, split by kind. Entries added
   * while a drain is running stay queued for the next batch.
   */
  takeBatch(projectId: number, max: number): { upserts: string[]; deletes: string[]; total: number } {
    const map = this.byProject.get(projectId);
    const upserts: string[] = [];
    const deletes: string[] = [];
    if (!map) return { upserts, deletes, total: 0 };
    for (const [path, kind] of map) {
      if (upserts.length + deletes.length >= max) break;
      (kind === 'delete' ? deletes : upserts).push(path);
      map.delete(path);
    }
    if (map.size === 0) this.byProject.delete(projectId);
    return { upserts, deletes, total: upserts.length + deletes.length };
  }

  clear(projectId: number): void {
    this.byProject.delete(projectId);
  }
}
