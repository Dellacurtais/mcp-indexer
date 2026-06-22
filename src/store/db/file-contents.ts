import type { DB } from './types.js';

/** Mirror of the scanner's size cap — defense for watcher-path callers. */
const MAX_CONTENT_BYTES = 200 * 1024;
/** Average line length above this reads as minified/data, not code. */
const MAX_AVG_LINE_LEN = 500;

/**
 * Whether raw content belongs in `file_contents_fts`. The scanner already
 * filters binaries/oversized files, but watcher-grade callers feed arbitrary
 * paths — re-check here so the index never bloats on minified bundles.
 */
export function isContentIndexable(content: string, sizeBytes?: number): boolean {
  const bytes = sizeBytes ?? Buffer.byteLength(content, 'utf-8');
  if (bytes === 0 || bytes > MAX_CONTENT_BYTES) return false;
  if (content.indexOf(String.fromCharCode(0)) !== -1) return false; // binary sniff (NUL byte)
  const lineCount = content.split('\n').length;
  return content.length / lineCount <= MAX_AVG_LINE_LEN;
}

/**
 * Set-or-clear the content index entry for a file. Contentless FTS5 has no
 * UPDATE — delete + insert (contentless_delete=1 makes the delete legal).
 * When the content fails the indexability guard the stale entry is REMOVED
 * (a file that became minified must stop matching). Returns whether the
 * file is now content-indexed.
 */
export function upsertContent(db: DB, fileId: number, content: string, sizeBytes?: number): boolean {
  db.prepare('DELETE FROM file_contents_fts WHERE rowid = ?').run(fileId);
  if (!isContentIndexable(content, sizeBytes)) return false;
  db.prepare('INSERT INTO file_contents_fts(rowid, content) VALUES (?, ?)').run(fileId, content);
  return true;
}

export function removeContent(db: DB, fileId: number): void {
  db.prepare('DELETE FROM file_contents_fts WHERE rowid = ?').run(fileId);
}

export interface ContentMatch {
  id: number;
  path: string;
  rank: number;
}

/**
 * MATCH over raw contents, scoped to one project. `match` must already be a
 * valid FTS5 query (callers sanitize); a malformed expression throws
 * SQLITE_ERROR like every other FTS path here. Slim rows — callers rehydrate
 * full file records by id when they need more than the path.
 */
export function searchContent(db: DB, projectId: number, match: string, limit: number = 50): ContentMatch[] {
  return db.prepare(`
    SELECT f.id as id, f.path as path, c.rank as rank
    FROM file_contents_fts c
    JOIN files f ON f.id = c.rowid
    WHERE c.file_contents_fts MATCH ? AND f.project_id = ?
    ORDER BY c.rank
    LIMIT ?
  `).all(match, projectId, limit) as ContentMatch[];
}

/**
 * Files lacking a content-index entry — feeds the coverage sweep (first
 * upgrade backfill + post-corruption self-heal + failed-write repair).
 */
export function missingContentFiles(db: DB, projectId: number, limit: number = 500): Array<{ id: number; path: string }> {
  return db.prepare(`
    SELECT f.id as id, f.path as path FROM files f
    WHERE f.project_id = ?
      AND NOT EXISTS (SELECT 1 FROM file_contents_fts c WHERE c.rowid = f.id)
    LIMIT ?
  `).all(projectId, limit) as Array<{ id: number; path: string }>;
}

export function countContent(db: DB, projectId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM file_contents_fts c
    JOIN files f ON f.id = c.rowid
    WHERE f.project_id = ?
  `).get(projectId) as { cnt: number };
  return row.cnt;
}
