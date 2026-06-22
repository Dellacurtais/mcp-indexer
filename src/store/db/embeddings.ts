import type { DB } from './types.js';

export interface EmbeddingCoverage {
  files_total: number;
  files_embedded: number;
  symbols_total: number;
  symbols_embedded: number;
  symbol_bodies_total: number;
  symbol_bodies_embedded: number;
}

export function sampleEmbeddedFiles(db: DB, projectId: number, limit = 5): Array<{ id: number; path: string; embedding_hash: string }> {
  return db.prepare(
    `SELECT id, path, embedding_hash FROM files
     WHERE project_id = ? AND embedding_hash IS NOT NULL
     ORDER BY RANDOM() LIMIT ?`,
  ).all(projectId, limit) as Array<{ id: number; path: string; embedding_hash: string }>;
}

export function sampleNotEmbeddedFiles(db: DB, projectId: number, limit = 5): Array<{ id: number; path: string }> {
  return db.prepare(
    `SELECT id, path FROM files
     WHERE project_id = ? AND embedding_hash IS NULL
     ORDER BY RANDOM() LIMIT ?`,
  ).all(projectId, limit) as Array<{ id: number; path: string }>;
}

export function getFileHashes(db: DB, fileIds: number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  if (fileIds.length === 0) return out;
  const placeholders = fileIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, embedding_hash FROM files WHERE id IN (${placeholders})`)
    .all(...fileIds) as Array<{ id: number; embedding_hash: string | null }>;
  for (const r of rows) out.set(r.id, r.embedding_hash);
  return out;
}

export function setFileHash(db: DB, fileId: number, hash: string): void {
  db.prepare('UPDATE files SET embedding_hash = ? WHERE id = ?').run(hash, fileId);
}

export function getFileStructureHash(db: DB, projectId: number, path: string): string | null {
  const row = db.prepare('SELECT structure_hash FROM files WHERE project_id = ? AND path = ?')
    .get(projectId, path) as { structure_hash: string | null } | undefined;
  return row?.structure_hash ?? null;
}

export function setFileStructureHash(db: DB, fileId: number, hash: string): void {
  db.prepare('UPDATE files SET structure_hash = ? WHERE id = ?').run(hash, fileId);
}

export function getFileStructureEmbedding(db: DB, projectId: number, path: string): Float32Array | null {
  const row = db.prepare('SELECT structure_embedding FROM files WHERE project_id = ? AND path = ?')
    .get(projectId, path) as { structure_embedding: Buffer | null } | undefined;
  if (row?.structure_embedding) {
    return new Float32Array(row.structure_embedding.buffer, row.structure_embedding.byteOffset, row.structure_embedding.byteLength / 4);
  }
  return null;
}

export function setFileStructureEmbedding(db: DB, fileId: number, embedding: Float32Array): void {
  const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  db.prepare('UPDATE files SET structure_embedding = ? WHERE id = ?').run(buffer, fileId);
}

export function getSymbolHashes(db: DB, symbolIds: number[]): Map<number, { sig: string | null; body: string | null }> {
  const out = new Map<number, { sig: string | null; body: string | null }>();
  if (symbolIds.length === 0) return out;
  const placeholders = symbolIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, embedding_hash, body_embedding_hash FROM symbols WHERE id IN (${placeholders})`
  ).all(...symbolIds) as Array<{ id: number; embedding_hash: string | null; body_embedding_hash: string | null }>;
  for (const r of rows) out.set(r.id, { sig: r.embedding_hash, body: r.body_embedding_hash });
  return out;
}

export function setSymbolHash(db: DB, symbolId: number, hash: string, kind: 'sig' | 'body'): void {
  const col = kind === 'sig' ? 'embedding_hash' : 'body_embedding_hash';
  db.prepare(`UPDATE symbols SET ${col} = ? WHERE id = ?`).run(hash, symbolId);
}

/**
 * Null every embedding hash for a project so the next index re-embeds all
 * content. Used when the embedding model/dimension changes — otherwise the
 * incremental hash check would skip re-embedding and leave the new (e.g.
 * sqlite-vec) store empty / dimension-mismatched.
 */
export function clearHashes(db: DB, projectId: number): void {
  const tx = db.transaction(() => {
    db.prepare('UPDATE files SET embedding_hash = NULL WHERE project_id = ?').run(projectId);
    db.prepare('UPDATE symbols SET embedding_hash = NULL, body_embedding_hash = NULL WHERE project_id = ?').run(projectId);
    db.prepare('UPDATE snapshots SET embedding_hash = NULL WHERE project_id = ?').run(projectId);
  });
  tx();
}

export function coverage(db: DB, projectId: number): EmbeddingCoverage {
  const files = db.prepare(
    'SELECT COUNT(*) AS total, COUNT(embedding_hash) AS embedded FROM files WHERE project_id = ?'
  ).get(projectId) as { total: number; embedded: number };
  const symbols = db.prepare(
    `SELECT COUNT(*) AS total, COUNT(embedding_hash) AS embedded, COUNT(body_embedding_hash) AS bodies,
            SUM(CASE WHEN kind IN ('class','function','interface','method') AND line IS NOT NULL THEN 1 ELSE 0 END) AS bodies_eligible
     FROM symbols WHERE project_id = ?`
  ).get(projectId) as { total: number; embedded: number; bodies: number; bodies_eligible: number };
  return {
    files_total: files.total,
    files_embedded: files.embedded,
    symbols_total: symbols.total,
    symbols_embedded: symbols.embedded,
    symbol_bodies_total: symbols.bodies_eligible,
    symbol_bodies_embedded: symbols.bodies,
  };
}
