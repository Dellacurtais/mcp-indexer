/**
 * FileLocalHistoryStore — persistência do Local History (mig 160).
 *
 * Content-addressed: cada revisão aponta para um blob (hash → content)
 * refcounted, então conteúdo idêntico (revert, ida-e-volta de branch) não
 * duplica. Satélite construído sobre `db.raw()` (padrão dos demais *-store),
 * fora do CodeIndexDB.
 */
import type DatabaseConstructor from 'better-sqlite3';
import { createHash } from 'node:crypto';

type DB = InstanceType<typeof DatabaseConstructor>;

export type HistoryKind = 'save' | 'external' | 'pre-delete' | 'pre-agent' | 'manual';

export interface HistoryRevisionRow {
  id: number;
  project_id: number;
  path: string;
  content_hash: string | null;
  size: number;
  kind: HistoryKind;
  label: string | null;
  existed_before: number;
  oversized: number;
  created_at: string;
}

export interface RecordRevisionInput {
  projectId: number;
  path: string;
  /** null ⇒ o arquivo não existia (existed_before=0; restore = delete). */
  content: string | null;
  kind: HistoryKind;
  label?: string | null;
  /** binário/grande — caller pré-computou; conteúdo não é guardado. */
  oversized?: boolean;
  /** Tamanho real (bytes) — usado p/ oversized, onde `content` é null mas o arquivo existe. */
  size?: number;
}

export interface PruneOpts {
  maxPerFile: number;
  maxAgeDays: number;
}

function hashContent(content: string): string {
  // Normaliza CRLF/CR → LF (CRLF↔LF não gera revisão fantasma). Blob guarda bytes originais.
  return createHash('md5').update(content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')).digest('hex');
}

export class FileLocalHistoryStore {
  constructor(private readonly db: DB) {}

  /** Insere blob (refcounted) + revisão numa tx. Retorna null em dedup. */
  recordRevision(input: RecordRevisionInput): HistoryRevisionRow | null {
    const { projectId, path, content, kind } = input;
    const oversized = input.oversized ? 1 : 0;
    // Oversized = o arquivo EXISTE mas não cabe → existed_before=1; content=null sem
    // oversized = tombstone "não existia" → existed_before=0.
    const existedBefore = oversized ? 1 : content == null ? 0 : 1;
    const hash = content != null && !oversized ? hashContent(content) : null;
    const size = input.size ?? (content != null ? Buffer.byteLength(content, 'utf8') : 0);

    if (hash) {
      const last = this.db
        .prepare(
          `SELECT content_hash FROM file_local_history WHERE project_id=? AND path=? ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(projectId, path) as { content_hash: string | null } | undefined;
      if (last && last.content_hash === hash) return null; // sem mudança desde a última revisão
    }

    const id = this.db.transaction(() => {
      if (hash && content != null) {
        this.db
          .prepare(
            `INSERT INTO file_history_blobs (hash, content, size, refcount) VALUES (?, ?, ?, 1)
             ON CONFLICT(hash) DO UPDATE SET refcount = refcount + 1`,
          )
          .run(hash, content, size);
      }
      const res = this.db
        .prepare(
          `INSERT INTO file_local_history (project_id, path, content_hash, size, kind, label, existed_before, oversized)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(projectId, path, hash, size, kind, input.label ?? null, existedBefore, oversized);
      return Number(res.lastInsertRowid);
    })();

    return this.getRevision(id);
  }

  listRevisions(projectId: number, path: string, limit = 100): HistoryRevisionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM file_local_history WHERE project_id=? AND path=? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(projectId, path, limit) as HistoryRevisionRow[];
  }

  getRevision(id: number): HistoryRevisionRow | null {
    return (this.db.prepare(`SELECT * FROM file_local_history WHERE id=?`).get(id) as HistoryRevisionRow | undefined) ?? null;
  }

  /** Conteúdo da revisão (join no blob). null para oversized/inexistente. */
  getRevisionContent(id: number): string | null {
    const row = this.getRevision(id);
    if (!row?.content_hash) return null;
    const blob = this.db.prepare(`SELECT content FROM file_history_blobs WHERE hash=?`).get(row.content_hash) as
      | { content: string }
      | undefined;
    return blob?.content ?? null;
  }

  labelRevision(id: number, label: string): void {
    this.db.prepare(`UPDATE file_local_history SET label=? WHERE id=?`).run(label, id);
  }

  /** Decrementa refcount das linhas removidas e dropa blobs órfãos. */
  private deleteRows(rows: Array<{ id: number; content_hash: string | null }>): void {
    if (rows.length === 0) return;
    const delRev = this.db.prepare(`DELETE FROM file_local_history WHERE id=?`);
    const decr = this.db.prepare(`UPDATE file_history_blobs SET refcount = refcount - 1 WHERE hash=?`);
    for (const r of rows) {
      delRev.run(r.id);
      if (r.content_hash) decr.run(r.content_hash);
    }
    this.db.prepare(`DELETE FROM file_history_blobs WHERE refcount <= 0`).run();
  }

  /** GC por arquivo: cap (oldest-first) + idade. Linhas rotuladas/`manual` ficam. */
  pruneForFile(projectId: number, path: string, opts: PruneOpts): number {
    return this.db.transaction(() => {
      const prunable = `kind != 'manual' AND label IS NULL`;
      const aged = this.db
        .prepare(
          `SELECT id, content_hash FROM file_local_history
            WHERE project_id=? AND path=? AND ${prunable} AND created_at < datetime('now', ?)`,
        )
        .all(projectId, path, `-${opts.maxAgeDays} days`) as Array<{ id: number; content_hash: string | null }>;
      const overCap = this.db
        .prepare(
          `SELECT id, content_hash FROM file_local_history
            WHERE project_id=? AND path=? AND ${prunable}
            ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`,
        )
        .all(projectId, path, opts.maxPerFile) as Array<{ id: number; content_hash: string | null }>;
      const byId = new Map<number, string | null>();
      for (const r of [...aged, ...overCap]) byId.set(r.id, r.content_hash);
      const rows = [...byId].map(([id, content_hash]) => ({ id, content_hash }));
      this.deleteRows(rows);
      return rows.length;
    })();
  }

  /** Teardown de projeto — remove tudo do projeto + blobs órfãos. */
  pruneForProject(projectId: number): void {
    this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT id, content_hash FROM file_local_history WHERE project_id=?`)
        .all(projectId) as Array<{ id: number; content_hash: string | null }>;
      this.deleteRows(rows);
    })();
  }
}
