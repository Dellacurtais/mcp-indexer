import type { DBSymbol, LLMSymbol } from '@ctx/shared/types.js';
import { computeStableId } from '../migrations/002_symbol_stable_id.js';
import type { DB } from './types.js';

export interface FindSymbolOptions {
  filePath?: string;
  kind?: string;
}

export interface FindSymbolsOptions extends FindSymbolOptions {
  limit?: number;
}

export function upsert(db: DB, projectId: number, fileId: number, filePath: string, symbols: LLMSymbol[]): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM symbol_relations WHERE symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(fileId);
    db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);

    const insert = db.prepare(`
      INSERT INTO symbols (project_id, file_id, file_path, name, kind, signature,
        parent, modifiers, return_type, parameters, line, col, end_line, exported,
        comment, tags, stable_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertRelation = db.prepare(`
      INSERT INTO symbol_relations (project_id, symbol_id, related_symbol_name, relation_type)
      VALUES (?, ?, ?, ?)
    `);

    for (const sym of symbols) {
      const stableId = computeStableId({
        projectId,
        filePath,
        kind: sym.kind,
        parent: sym.parent,
        name: sym.name,
        signature: sym.signature,
      });
      const result = insert.run(
        projectId, fileId, filePath, sym.name, sym.kind, sym.signature,
        sym.parent, JSON.stringify(sym.modifiers), sym.return_type,
        sym.parameters, sym.line, sym.col ?? null, sym.end_line ?? null,
        sym.exported ? 1 : 0, sym.comment, JSON.stringify(sym.tags),
        stableId
      );

      const symId = result.lastInsertRowid as number;

      if (sym.extends_from) {
        insertRelation.run(projectId, symId, sym.extends_from, 'extends');
      }
      if (sym.implements_list && sym.implements_list.length > 0) {
        for (const iface of sym.implements_list) {
          insertRelation.run(projectId, symId, iface, 'implements');
        }
      }
    }
  });

  tx();
}

export function getById(db: DB, id: number): DBSymbol | undefined {
  return db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as DBSymbol | undefined;
}

export function getByFile(db: DB, projectId: number, filePath: string): DBSymbol[] {
  return db.prepare('SELECT * FROM symbols WHERE project_id = ? AND file_path = ? ORDER BY line')
    .all(projectId, filePath) as DBSymbol[];
}

export function findByStableId(db: DB, projectId: number, stableId: string): DBSymbol | undefined {
  return db.prepare('SELECT * FROM symbols WHERE project_id = ? AND stable_id = ? LIMIT 1')
    .get(projectId, stableId) as DBSymbol | undefined;
}

export function findByName(db: DB, projectId: number, name: string, opts?: FindSymbolOptions): DBSymbol | undefined {
  const parts = ['project_id = ?', 'name = ?'];
  const params: (string | number)[] = [projectId, name];
  if (opts?.filePath) {
    parts.push('file_path = ?');
    params.push(opts.filePath);
  }
  if (opts?.kind) {
    parts.push('kind = ?');
    params.push(opts.kind);
  }
  const sql = `SELECT * FROM symbols WHERE ${parts.join(' AND ')} LIMIT 1`;
  return db.prepare(sql).get(...params) as DBSymbol | undefined;
}

export function findManyByName(db: DB, projectId: number, name: string, opts?: FindSymbolsOptions): DBSymbol[] {
  const parts = ['project_id = ?', 'name = ?'];
  const params: (string | number)[] = [projectId, name];
  if (opts?.filePath) {
    parts.push('file_path = ?');
    params.push(opts.filePath);
  }
  if (opts?.kind) {
    parts.push('kind = ?');
    params.push(opts.kind);
  }
  const limit = opts?.limit ?? 20;
  const sql = `SELECT * FROM symbols WHERE ${parts.join(' AND ')} ORDER BY file_path, line LIMIT ${limit}`;
  return db.prepare(sql).all(...params) as DBSymbol[];
}

export function classMembers(db: DB, parentName: string, projectId: number): DBSymbol[] {
  return db.prepare('SELECT * FROM symbols WHERE parent = ? AND project_id = ? ORDER BY line')
    .all(parentName, projectId) as DBSymbol[];
}

export function listAll(db: DB, projectId: number): DBSymbol[] {
  return db.prepare('SELECT * FROM symbols WHERE project_id = ? ORDER BY name')
    .all(projectId) as DBSymbol[];
}

/**
 * Identifier-prefix completion. Deliberately a b-tree range scan, NOT FTS:
 * `symbols_fts` tokenizes with unicode61 where `_` splits tokens, so
 * `my_func*` can never prefix-match `my_function`. The range
 * `name >= prefix AND name < prefix + U+10FFFF` walks
 * `idx_symbols_project_name(project_id, name)` — O(log N) seek + K rows,
 * case-SENSITIVE (BINARY collation is what makes the index usable).
 */
export function searchByPrefix(
  db: DB,
  projectId: number,
  prefix: string,
  limit: number = 50,
  opts?: { exportedOnly?: boolean },
): DBSymbol[] {
  if (!prefix) return [];
  return db.prepare(`
    SELECT * FROM symbols
    WHERE project_id = ? AND name >= ? AND name < ?
      ${opts?.exportedOnly ? 'AND exported = 1' : ''}
    ORDER BY exported DESC, LENGTH(name) ASC, name ASC
    LIMIT ?
  `).all(projectId, prefix, prefix + '\u{10FFFF}', limit) as DBSymbol[];
}

export function search(db: DB, projectId: number, query: string, limit: number = 20): DBSymbol[] {
  return db.prepare(`
    SELECT s.* FROM symbols_fts fts
    JOIN symbols s ON s.id = fts.rowid
    WHERE fts.symbols_fts MATCH ? AND s.project_id = ?
    ORDER BY rank
    LIMIT ?
  `).all(query, projectId, limit) as DBSymbol[];
}

export function listByKind(db: DB, projectId: number, kind: string, limit: number = 50): DBSymbol[] {
  return db.prepare('SELECT * FROM symbols WHERE project_id = ? AND kind = ? ORDER BY name LIMIT ?')
    .all(projectId, kind, limit) as DBSymbol[];
}
