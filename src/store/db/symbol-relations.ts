import type { DBSymbol, DBSymbolReference, DBSymbolRelation } from '@ctx/shared/types.js';
import type { DB } from './types.js';

export interface SymbolReferenceInput {
  symbol_name: string;
  kind: string;
  line?: number;
  /** Start column of the reference (1-based) — migration 141. */
  col?: number;
  snippet?: string;
}

export function upsertReferences(db: DB, projectId: number, fileId: number, filePath: string, references: SymbolReferenceInput[]): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM symbol_references WHERE referencing_file_id = ?').run(fileId);

    const insert = db.prepare(`
      INSERT INTO symbol_references (project_id, symbol_id, symbol_name, referencing_file_id, referencing_file_path, line, col, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const ref of references) {
      const sym = db.prepare(
        'SELECT id FROM symbols WHERE project_id = ? AND name = ? LIMIT 1'
      ).get(projectId, ref.symbol_name) as { id: number } | undefined;

      insert.run(
        projectId,
        sym?.id ?? null,
        ref.symbol_name,
        fileId,
        filePath,
        ref.line ?? null,
        ref.col ?? null,
        ref.snippet ?? null
      );
    }
  });

  tx();
}

export function getReferences(db: DB, symbolId: number): DBSymbolReference[] {
  return db.prepare('SELECT * FROM symbol_references WHERE symbol_id = ? ORDER BY referencing_file_path')
    .all(symbolId) as DBSymbolReference[];
}

export function getCallers(db: DB, projectId: number, symbolName: string): DBSymbolReference[] {
  return db.prepare('SELECT * FROM symbol_references WHERE project_id = ? AND symbol_name = ? ORDER BY referencing_file_path')
    .all(projectId, symbolName) as DBSymbolReference[];
}

export function getRelations(db: DB, symbolId: number): DBSymbolRelation[] {
  return db.prepare('SELECT * FROM symbol_relations WHERE symbol_id = ?')
    .all(symbolId) as DBSymbolRelation[];
}

export function getImplementors(db: DB, projectId: number, interfaceName: string): DBSymbol[] {
  return db.prepare(`
    SELECT s.* FROM symbol_relations sr
    JOIN symbols s ON s.id = sr.symbol_id
    WHERE sr.project_id = ? AND sr.related_symbol_name = ? AND sr.relation_type = 'implements'
    ORDER BY s.name
  `).all(projectId, interfaceName) as DBSymbol[];
}

export function getSubclasses(db: DB, projectId: number, className: string): DBSymbol[] {
  return db.prepare(`
    SELECT s.* FROM symbol_relations sr
    JOIN symbols s ON s.id = sr.symbol_id
    WHERE sr.project_id = ? AND sr.related_symbol_name = ? AND sr.relation_type = 'extends'
    ORDER BY s.name
  `).all(projectId, className) as DBSymbol[];
}

export interface SymbolHierarchy {
  symbol: DBSymbol | undefined;
  extends_chain: string[];
  implements_list: string[];
  subclasses: DBSymbol[];
  implementors: DBSymbol[];
}

export function getHierarchy(db: DB, projectId: number, symbolName: string): SymbolHierarchy {
  const sym = db.prepare('SELECT * FROM symbols WHERE project_id = ? AND name = ? LIMIT 1')
    .get(projectId, symbolName) as DBSymbol | undefined;

  if (!sym) return { symbol: undefined, extends_chain: [], implements_list: [], subclasses: [], implementors: [] };

  const relations = getRelations(db, sym.id);
  const extends_chain = relations.filter(r => r.relation_type === 'extends').map(r => r.related_symbol_name);
  const implements_list = relations.filter(r => r.relation_type === 'implements').map(r => r.related_symbol_name);
  const subclasses = getSubclasses(db, projectId, symbolName);
  const implementors = getImplementors(db, projectId, symbolName);

  return { symbol: sym, extends_chain, implements_list, subclasses, implementors };
}

export interface UsageTraceNode {
  file: string;
  line: number | null;
  symbols_in_file: string[];
  callers: unknown[];
}

export interface UsageTraceResult {
  symbol: string;
  defined_in: string | null;
  callers: UsageTraceNode[];
}

export function traceUsage(db: DB, projectId: number, symbolName: string, maxDepth: number = 3): UsageTraceResult {
  const sym = db.prepare('SELECT * FROM symbols WHERE project_id = ? AND name = ? LIMIT 1')
    .get(projectId, symbolName) as DBSymbol | undefined;

  const definedIn = sym?.file_path ?? null;
  const visited = new Set<string>();

  const trace = (name: string, depth: number): UsageTraceNode[] => {
    if (depth >= maxDepth || visited.has(name)) return [];
    visited.add(name);

    const refs = db.prepare(`
      SELECT referencing_file_path, line, context
      FROM symbol_references
      WHERE project_id = ? AND symbol_name = ?
      ORDER BY referencing_file_path
    `).all(projectId, name) as Array<{ referencing_file_path: string; line: number | null; context: string | null }>;

    const result: UsageTraceNode[] = [];

    for (const ref of refs) {
      if (ref.referencing_file_path === definedIn) continue;

      const fileSymbols = db.prepare(
        'SELECT name FROM symbols WHERE project_id = ? AND file_path = ? AND (kind = ? OR kind = ? OR kind = ?)'
      ).all(projectId, ref.referencing_file_path, 'function', 'method', 'class') as Array<{ name: string }>;

      const symNames = fileSymbols.map(s => s.name);

      const nestedCallers: unknown[] = [];
      for (const s of symNames) {
        const nested = trace(s, depth + 1);
        if (nested.length > 0) nestedCallers.push(...nested);
      }

      result.push({
        file: ref.referencing_file_path,
        line: ref.line,
        symbols_in_file: symNames,
        callers: nestedCallers,
      });
    }

    return result;
  };

  return {
    symbol: symbolName,
    defined_in: definedIn,
    callers: trace(symbolName, 0),
  };
}
