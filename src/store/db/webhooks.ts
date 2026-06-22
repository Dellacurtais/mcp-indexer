import type { Webhook } from '@ctx/shared/types.js';
import type { DB } from './types.js';

export interface CreateWebhookData {
  projectId?: number;
  url: string;
  events: string[];
  secret?: string;
}

export function create(db: DB, data: CreateWebhookData): Webhook {
  const result = db.prepare(`
    INSERT INTO webhooks (project_id, url, events, secret)
    VALUES (?, ?, ?, ?)
  `).run(data.projectId ?? null, data.url, JSON.stringify(data.events), data.secret ?? null);
  return db.prepare('SELECT * FROM webhooks WHERE id = ?').get(result.lastInsertRowid) as Webhook;
}

export function list(db: DB, projectId?: number): Webhook[] {
  if (projectId !== undefined) {
    return db.prepare('SELECT * FROM webhooks WHERE project_id = ? OR project_id IS NULL ORDER BY created_at')
      .all(projectId) as Webhook[];
  }
  return db.prepare('SELECT * FROM webhooks ORDER BY created_at').all() as Webhook[];
}

export function del(db: DB, id: number): void {
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
}

export function forEvent(db: DB, projectId: number, event: string): Webhook[] {
  return db.prepare(`
    SELECT w.* FROM webhooks w, json_each(w.events) je
    WHERE (w.project_id = ? OR w.project_id IS NULL)
      AND w.active = 1
      AND je.value = ?
  `).all(projectId, event) as Webhook[];
}

export function updateStatus(db: DB, id: number, statusCode: number): void {
  db.prepare(`
    UPDATE webhooks SET last_triggered = datetime('now'), last_status = ? WHERE id = ?
  `).run(statusCode, id);
}
