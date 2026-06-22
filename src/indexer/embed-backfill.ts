/**
 * Embeddings backfill — the thin driver that gives code-context semantic /
 * hybrid search WITHOUT the upstream `IndexAgent` (which pulled chat-LLM
 * providers and the worker pool). It reuses the vendored, pure
 * `buildEmbeddingCandidates` (file + symbol-signature + symbol-body windows,
 * with incremental hash gating) and replicates the executor's write order:
 *
 *   embed(texts) → vectorStore.upsert(records, code:<project>) →
 *   db.saveVectorIds(...) → candidate.onCommit() (persists embedding_hash LAST).
 *
 * Only candidates whose text changed are produced, so re-runs after a watcher
 * reindex re-embed just the deltas.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CodeIndexDB } from '@ctx/store/db.js';
import type { EmbeddingService } from '@ctx/indexer/search/embeddings.js';
import type { VectorStore } from '@ctx/store/vectors.js';
import type { VectorRecord } from '@ctx/shared/types.js';
import { codeNamespace } from '@ctx/shared/vector-namespace.js';
import {
  buildEmbeddingCandidates,
  type CandidateFile,
  type CandidateSymbol,
} from '@ctx/indexer/indexer/indexer/embedding-candidates.js';

const BATCH = Math.max(1, Number(process.env.MCP_EMBED_BATCH ?? 64));

export interface EmbedBackfillResult {
  candidates: number;
  embedded: number;
  batches: number;
}

export interface EmbedBackfillOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

function parseConcepts(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? (p as string[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function runEmbedBackfill(
  db: CodeIndexDB,
  project: { id: number; name: string },
  root: string,
  embeddingService: EmbeddingService,
  vectorStore: VectorStore | null,
  opts: EmbedBackfillOptions = {},
): Promise<EmbedBackfillResult> {
  if (!vectorStore) return { candidates: 0, embedded: 0, batches: 0 };

  const candidateFiles: CandidateFile[] = [];
  for (const f of db.listFiles(project.id)) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(root, f.path), 'utf8');
    } catch {
      continue; // file gone since the structural pass — skip
    }
    // Keep end_line so body windows match the structural extractor's real symbol
    // span (candidate builder reads `(sym as {end_line?}).end_line`); without it
    // body ranges fall back to a next-symbol heuristic that over-captures and
    // churns the incremental hash.
    const symbols = db.getSymbolsByFile(project.id, f.path).map((s) => ({
      name: s.name,
      kind: s.kind,
      signature: s.signature,
      comment: s.comment,
      line: s.line,
      parent: s.parent,
      end_line: s.end_line,
    }));
    candidateFiles.push({
      path: f.path,
      fileId: f.id,
      language: f.language,
      summary: f.summary ?? '',
      concepts: parseConcepts((f as { concepts?: unknown }).concepts),
      symbols,
      content,
    });
  }

  const candidates = buildEmbeddingCandidates(db, project, candidateFiles);
  if (candidates.length === 0) return { candidates: 0, embedded: 0, batches: 0 };

  const ns = codeNamespace(project.name);
  let embedded = 0;
  let batches = 0;
  for (let i = 0; i < candidates.length; i += BATCH) {
    if (opts.signal?.aborted) break;
    const chunk = candidates.slice(i, i + BATCH);
    const { vectors } = await embeddingService.embed(chunk.map((c) => c.text));
    const records: VectorRecord[] = chunk.map((c, j) => ({
      id: c.id,
      values: vectors[j],
      metadata: c.metadata,
    }));
    await vectorStore.upsert(records, ns);
    db.saveVectorIds(
      project.id,
      chunk.map((c) => ({
        vectorId: c.id,
        filePath: c.filePath,
        type: c.metadata.type as 'file' | 'symbol' | 'symbol_body',
      })),
    );
    // Drop windows a shrunk symbol body no longer has (it went from N to M chunks),
    // mirroring the upstream executor — otherwise stale vectors linger in both the
    // store and vector_ids and pollute search top-K forever (invisible to the
    // file-deletion orphan check).
    const superseded = chunk.flatMap((c) => c.supersededIds ?? []);
    if (superseded.length > 0) {
      try {
        await vectorStore.deleteByIds(superseded, ns);
      } catch {
        /* best-effort: the local vector_ids rows are still removed below */
      }
      db.deleteVectorIdRows(project.id, superseded);
    }
    for (const c of chunk) c.onCommit();
    embedded += chunk.length;
    batches += 1;
    opts.onProgress?.(embedded, candidates.length);
  }
  return { candidates: candidates.length, embedded, batches };
}
