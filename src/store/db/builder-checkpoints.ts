/**
 * Builder checkpoint rows (migration 144) — the UI index over the real
 * git commits a Builder project accumulates: auto run-end checkpoints,
 * visual-edit bursts and restore commits, each optionally paired with a
 * preview screenshot (Electron capture; null elsewhere).
 */
import type { DB } from './types.js';

export type BuilderCheckpointKind = 'auto' | 'visual' | 'restore' | 'manual';

export interface BuilderCheckpoint {
  id: number;
  project_id: number;
  session_id: number | null;
  commit_sha: string;
  label: string;
  kind: BuilderCheckpointKind;
  screenshot_path: string | null;
  created_at: string;
}

export interface CreateBuilderCheckpointInput {
  project_id: number;
  session_id?: number | null;
  commit_sha: string;
  label: string;
  kind: BuilderCheckpointKind;
  screenshot_path?: string | null;
}

export function createBuilderCheckpoint(db: DB, input: CreateBuilderCheckpointInput): BuilderCheckpoint {
  const r = db
    .prepare(`
      INSERT INTO builder_checkpoints (project_id, session_id, commit_sha, label, kind, screenshot_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.project_id,
      input.session_id ?? null,
      input.commit_sha,
      input.label.slice(0, 200),
      input.kind,
      input.screenshot_path ?? null,
    );
  return getBuilderCheckpoint(db, Number(r.lastInsertRowid))!;
}

export function getBuilderCheckpoint(db: DB, id: number): BuilderCheckpoint | undefined {
  return db.prepare('SELECT * FROM builder_checkpoints WHERE id = ?').get(id) as
    | BuilderCheckpoint
    | undefined;
}

export function listBuilderCheckpoints(db: DB, projectId: number, limit = 50): BuilderCheckpoint[] {
  return db
    .prepare('SELECT * FROM builder_checkpoints WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .all(projectId, limit) as BuilderCheckpoint[];
}

/** Attach the screenshot captured after the row was created (best-effort). */
export function setBuilderCheckpointScreenshot(db: DB, id: number, screenshotPath: string): void {
  db.prepare('UPDATE builder_checkpoints SET screenshot_path = ? WHERE id = ?').run(screenshotPath, id);
}
