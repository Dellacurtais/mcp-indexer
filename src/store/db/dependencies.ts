import type { DBFileDependency, DBFileDependent } from '@ctx/shared/types.js';
import type { DB, PathAlias } from './types.js';
import { resolveDepToFile } from './path-resolver.js';

export function upsert(
  db: DB,
  projectId: number,
  sourceFileId: number,
  sourceFilePath: string,
  internalDeps: string[],
  externalDeps: string[],
  aliases: PathAlias[],
): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM file_dependencies WHERE source_file_id = ?').run(sourceFileId);

    const insert = db.prepare(`
      INSERT INTO file_dependencies (project_id, source_file_id, target_file_id, import_path, dep_type)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const dep of internalDeps) {
      const target = resolveDepToFile(db, projectId, dep, sourceFilePath, aliases);
      insert.run(projectId, sourceFileId, target?.id ?? null, dep, 'internal');
    }

    for (const dep of externalDeps) {
      insert.run(projectId, sourceFileId, null, dep, 'external');
    }
  });

  tx();
}

export function getDependencies(db: DB, fileId: number): DBFileDependency[] {
  return db.prepare(`
    SELECT fd.id, fd.import_path, fd.dep_type, f.path as target_file_path
    FROM file_dependencies fd
    LEFT JOIN files f ON f.id = fd.target_file_id
    WHERE fd.source_file_id = ?
    ORDER BY fd.dep_type, fd.import_path
  `).all(fileId) as DBFileDependency[];
}

export function getDependents(db: DB, projectId: number, fileId: number): DBFileDependent[] {
  return db.prepare(`
    SELECT fd.id, fd.import_path, sf.path as source_file_path
    FROM file_dependencies fd
    JOIN files sf ON sf.id = fd.source_file_id
    WHERE fd.target_file_id = ? AND fd.project_id = ?
    ORDER BY sf.path
  `).all(fileId, projectId) as DBFileDependent[];
}

/** Most depended-on files (in-degree) — single GROUP BY over the dep graph. */
export function getTopHubs(
  db: DB,
  projectId: number,
  limit: number,
): Array<{ path: string; dependents: number }> {
  return db.prepare(`
    SELECT f.path as path, COUNT(*) as dependents
    FROM file_dependencies fd
    JOIN files f ON f.id = fd.target_file_id
    WHERE fd.project_id = ? AND fd.target_file_id IS NOT NULL
    GROUP BY fd.target_file_id
    ORDER BY dependents DESC, f.path ASC
    LIMIT ?
  `).all(projectId, limit) as Array<{ path: string; dependents: number }>;
}

export function getCircular(db: DB, projectId: number): Array<{ path_a: string; path_b: string }> {
  return db.prepare(`
    SELECT DISTINCT f1.path as path_a, f2.path as path_b
    FROM file_dependencies d1
    JOIN file_dependencies d2 ON d1.target_file_id = d2.source_file_id
      AND d2.target_file_id = d1.source_file_id
    JOIN files f1 ON f1.id = d1.source_file_id
    JOIN files f2 ON f2.id = d1.target_file_id
    WHERE d1.project_id = ? AND f1.path < f2.path
  `).all(projectId) as Array<{ path_a: string; path_b: string }>;
}
