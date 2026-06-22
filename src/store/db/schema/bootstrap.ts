import type { DB } from '../types.js';

export function bootstrapV32Columns(db: DB): void {
  try { db.exec('SELECT layer FROM files LIMIT 1'); } catch {
    db.exec(`
      ALTER TABLE files ADD COLUMN layer TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE files ADD COLUMN is_entry_point INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE files ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE files ADD COLUMN is_generated INTEGER NOT NULL DEFAULT 0;
    `);
  }
}

export function rebuildSnapshotsFtsIfEmpty(db: DB): void {
  try {
    const count = (db.prepare('SELECT COUNT(*) as c FROM snapshots_fts').get() as { c: number }).c;
    if (count === 0) {
      const snapCount = (db.prepare('SELECT COUNT(*) as c FROM snapshots').get() as { c: number }).c;
      if (snapCount > 0) {
        db.exec(`INSERT INTO snapshots_fts(rowid, title, content, tags) SELECT id, title, content, tags FROM snapshots`);
      }
    }
  } catch { /* ignore */ }
}
