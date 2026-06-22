import type { DB } from '../types.js';

/**
 * `file_contents_fts` — contentless FTS5 word index over raw file contents.
 *
 * rowid == files.id (stable: files.upsert UPDATEs in place, never REPLACEs).
 * Insert/update happens in code (the content never lives in a base table);
 * only deletion is trigger-driven, via `files_contents_ad` on `files`, which
 * also covers project-delete cascades and clearProjectData's bulk DELETE.
 */
export function createFileContentsFts(db: DB): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS file_contents_fts USING fts5(
      content,
      content='',
      contentless_delete=1,
      detail='column',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS files_contents_ad AFTER DELETE ON files BEGIN
      DELETE FROM file_contents_fts WHERE rowid = old.id;
    END;
  `);
}

/**
 * Recovery for a corrupt `file_contents_fts`. Contentless tables cannot be
 * `'rebuild'`-repopulated (no external content source), so recovery is:
 * drop hard (incl. shadow tables when the vtab module refuses to open) and
 * recreate EMPTY. The next structural run's coverage sweep re-reads files
 * from disk and repopulates — self-healing, just not instant.
 */
export function repairFileContentsFts(db: DB): void {
  try { db.exec('DROP TRIGGER IF EXISTS files_contents_ad'); } catch { /* ignore */ }
  try {
    db.exec('DROP TABLE IF EXISTS file_contents_fts');
  } catch {
    // Corrupt vtab — bypass the module via writable_schema (same recovery as
    // dropFtsHard in fts.ts; duplicated to keep this module dependency-free).
    try {
      db.pragma('writable_schema = ON');
      db.prepare('DELETE FROM sqlite_master WHERE name = ?').run('file_contents_fts');
      for (const s of ['data', 'idx', 'docsize', 'config', 'content']) {
        try { db.exec(`DROP TABLE IF EXISTS file_contents_fts_${s}`); } catch { /* ignore */ }
      }
    } finally {
      db.pragma('writable_schema = OFF');
    }
  }
  createFileContentsFts(db);
}
