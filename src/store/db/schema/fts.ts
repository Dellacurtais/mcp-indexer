import type { DB } from '../types.js';
import { createFileContentsFts, repairFileContentsFts } from './content-fts.js';

export function createFtsTables(db: DB): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      path, summary, concepts, content='files', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      name, kind, signature, comment, tags, file_path, parent,
      content='symbols', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
      INSERT INTO files_fts(rowid, path, summary, concepts)
      VALUES (new.id, new.path, new.summary, new.concepts);
    END;

    CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, path, summary, concepts)
      VALUES ('delete', old.id, old.path, old.summary, old.concepts);
    END;

    CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
      INSERT INTO symbols_fts(rowid, name, kind, signature, comment, tags, file_path, parent)
      VALUES (new.id, new.name, new.kind, new.signature, COALESCE(new.comment,''), new.tags, new.file_path, COALESCE(new.parent,''));
    END;

    CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, kind, signature, comment, tags, file_path, parent)
      VALUES ('delete', old.id, old.name, old.kind, old.signature, COALESCE(old.comment,''), old.tags, old.file_path, COALESCE(old.parent,''));
    END;
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS snapshots_fts USING fts5(
      title, content, tags,
      content='snapshots', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS snapshots_ai AFTER INSERT ON snapshots BEGIN
      INSERT INTO snapshots_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS snapshots_ad AFTER DELETE ON snapshots BEGIN
      INSERT INTO snapshots_fts(snapshots_fts, rowid, title, content, tags)
      VALUES ('delete', old.id, old.title, old.content, old.tags);
    END;
  `);

  createFileContentsFts(db);
}

const CODE_FTS_TRIGGERS = [
  'files_ai', 'files_ad', 'symbols_ai', 'symbols_ad', 'snapshots_ai', 'snapshots_ad',
] as const;
const CODE_FTS_TABLES = ['files_fts', 'symbols_fts', 'snapshots_fts'] as const;

/** Force-drop a (possibly corrupt) FTS5 vtab. DROP TABLE usually works even on
 *  a malformed index; if the vtab module can't open it, remove its sqlite_master
 *  entry + shadow tables directly (the documented FTS5 corruption recovery). */
function dropFtsHard(db: DB, name: string): void {
  try {
    db.exec(`DROP TABLE IF EXISTS ${name}`);
    return;
  } catch {
    // Corrupt vtab — bypass the module via writable_schema.
  }
  try {
    db.pragma('writable_schema = ON');
    db.prepare('DELETE FROM sqlite_master WHERE name = ?').run(name);
    for (const s of ['data', 'idx', 'docsize', 'config', 'content']) {
      try { db.exec(`DROP TABLE IF EXISTS ${name}_${s}`); } catch { /* ignore */ }
    }
  } finally {
    db.pragma('writable_schema = OFF');
  }
}

/**
 * Rebuild the code-side FTS5 indexes (files/symbols/snapshots) from scratch.
 * Used to recover from `SQLITE_CORRUPT_VTAB` — drops the triggers + (corrupt)
 * virtual tables, recreates them, then repopulates from the external content
 * tables. Safe: the base tables hold the source of truth; only the derived
 * index is rebuilt.
 */
export function repairCodeFtsIndexes(db: DB): void {
  for (const t of CODE_FTS_TRIGGERS) {
    try { db.exec(`DROP TRIGGER IF EXISTS ${t}`); } catch { /* ignore */ }
  }
  for (const t of CODE_FTS_TABLES) dropFtsHard(db, t);
  // Contentless — cannot 'rebuild' (no external content source). Recreated
  // EMPTY here; the next structural run's coverage sweep repopulates it.
  repairFileContentsFts(db);
  createFtsTables(db); // recreate vtabs + triggers
  for (const t of CODE_FTS_TABLES) {
    try { db.exec(`INSERT INTO ${t}(${t}) VALUES('rebuild')`); } catch { /* base table empty/absent */ }
  }
}

export function createDocChunksFtsIfReady(db: DB): void {
  try {
    db.exec(`SELECT 1 FROM doc_chunks LIMIT 1`);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
        content, summary, heading_path,
        content='doc_chunks', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(rowid, content, summary, heading_path)
        VALUES (new.id, new.content, COALESCE(new.summary,''), COALESCE(new.heading_path,''));
      END;

      CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content, summary, heading_path)
        VALUES ('delete', old.id, old.content, COALESCE(old.summary,''), COALESCE(old.heading_path,''));
      END;

      CREATE TRIGGER IF NOT EXISTS doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content, summary, heading_path)
        VALUES ('delete', old.id, old.content, COALESCE(old.summary,''), COALESCE(old.heading_path,''));
        INSERT INTO doc_chunks_fts(rowid, content, summary, heading_path)
        VALUES (new.id, new.content, COALESCE(new.summary,''), COALESCE(new.heading_path,''));
      END;
    `);

    try {
      const count = (db.prepare('SELECT COUNT(*) as c FROM doc_chunks_fts').get() as { c: number }).c;
      if (count === 0) {
        const chunkCount = (db.prepare('SELECT COUNT(*) as c FROM doc_chunks').get() as { c: number }).c;
        if (chunkCount > 0) {
          db.exec(
            `INSERT INTO doc_chunks_fts(rowid, content, summary, heading_path)
             SELECT id, content, COALESCE(summary,''), COALESCE(heading_path,'') FROM doc_chunks`,
          );
        }
      }
    } catch { /* ignore */ }
  } catch { /* doc_chunks table not yet created — migration 086 not yet applied */ }
}
