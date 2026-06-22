import { createHash } from 'node:crypto';
import type { CodeIndexDB } from '@ctx/store/db.js';
import { slidingWindows } from '@ctx/shared/utils/sliding-window.js';

export interface CandidateSymbol {
  name: string;
  kind: string;
  signature?: string | null;
  comment?: string | null;
  line?: number | null;
  parent?: string | null;
}

export interface CandidateFile {
  path: string;
  fileId: number;
  language: string;
  summary: string;
  concepts: string[];
  symbols: CandidateSymbol[];
  content: string;
}

export interface EmbeddingCandidate {
  text: string;
  id: string;
  filePath: string;
  metadata: Record<string, string>;
  hash: string;
  /**
   * Persists the candidate's hash. MUST stay synchronous — the executor
   * runs the whole chunk's commits inside ONE better-sqlite3 transaction.
   */
  onCommit: () => void;
  /**
   * Candidates sharing a groupKey form one logical unit (the windows of a
   * multi-chunk symbol body). Batch slicers must keep a group inside a
   * single batch — its hash commit (carried by the LAST member) assumes
   * every earlier window landed in the same or an earlier-successful batch.
   */
  groupKey?: string;
  /**
   * Vector ids made stale by this candidate (a body that shrank from N to
   * M windows leaves ids M..N-1 behind — invisible to the orphan check
   * because the file still exists). The executor deletes them after a
   * successful upsert; failures fall into the tombstone queue.
   */
  supersededIds?: string[];
}

interface SkippedSymbolGroup {
  sym: CandidateSymbol;
  symDbId: number;
  lineStart: number;
  lineEnd: number;
}

const MIN_BODY_LINES = Number(process.env.MCP_INDEX_BODY_MIN_LINES ?? 8);
const MAX_BODY_CHARS = Number(process.env.MCP_INDEX_BODY_MAX_CHARS ?? 2500);
// Bodies over MAX_BODY_CHARS are split into overlapping windows instead of
// being truncated, so the tail of large functions stays searchable.
const BODY_OVERLAP_CHARS = Number(process.env.MCP_INDEX_BODY_OVERLAP_CHARS ?? 250);
const MAX_BODY_CHUNKS = Number(process.env.MCP_INDEX_BODY_MAX_CHUNKS ?? 4);
const SIBLING_GAP = 3;
const GROUP_MIN_LINES = 3;

/**
 * Build embedding candidates from a list of files with their analysis data
 * and content. Shared by `processEmbeddings` (after LLM analysis) and
 * `retryEmbeddings` (standalone, reading from DB + disk).
 *
 * Skips files whose stored hash matches the recomputed text — incremental
 * re-index only re-embeds what changed.
 */
export function buildEmbeddingCandidates(
  db: CodeIndexDB,
  project: { id: number; name: string },
  files: CandidateFile[],
): EmbeddingCandidate[] {
  const candidates: EmbeddingCandidate[] = [];

  const fileIds = files.map((f) => f.fileId);
  const fileHashMap = db.getFileEmbeddingHashes(fileIds, project.id);

  const allSymbolIds: number[] = [];
  const symIdMapByFile = new Map<string, Map<string, number>>();
  for (const file of files) {
    const dbSymbols = db.getSymbolsByFile(project.id, file.path);
    const map = new Map(dbSymbols.map((s) => [`${s.kind}:${s.name}`, s.id]));
    symIdMapByFile.set(file.path, map);
    for (const s of dbSymbols) allSymbolIds.push(s.id);
  }
  const symHashMap = db.getSymbolEmbeddingHashes(allSymbolIds, project.id);

  for (const file of files) {
    appendFileCandidate(candidates, db, project, file, fileHashMap);
    appendSymbolCandidates(candidates, db, project, file, symIdMapByFile, symHashMap);
  }

  return candidates;
}

function appendFileCandidate(
  candidates: EmbeddingCandidate[],
  db: CodeIndexDB,
  project: { id: number; name: string },
  file: CandidateFile,
  fileHashMap: Map<number, string | null>,
): void {
  const fileText = [
    `File: ${file.path}`,
    `Language: ${file.language}`,
    `Summary: ${file.summary}`,
    `Concepts: ${file.concepts.join(', ')}`,
    `Symbols: ${file.symbols.map((s) => s.name).join(', ')}`,
  ].join('\n').slice(0, 1000);

  const fileHash = createHash('md5').update(fileText).digest('hex');
  const fileVecId = 'f_' + createHash('md5').update(`${project.id}:${file.path}`).digest('hex').slice(0, 24);
  const storedFileHash = fileHashMap.get(file.fileId) ?? null;

  if (storedFileHash !== fileHash) {
    candidates.push({
      text: fileText,
      id: fileVecId,
      filePath: file.path,
      metadata: { project_name: project.name, type: 'file', ref_id: String(file.fileId) },
      hash: fileHash,
      onCommit: () => db.setFileEmbeddingHash(file.fileId, fileHash, project.id),
    });
  }
}

function appendSymbolCandidates(
  candidates: EmbeddingCandidate[],
  db: CodeIndexDB,
  project: { id: number; name: string },
  file: CandidateFile,
  symIdMapByFile: Map<string, Map<string, number>>,
  symHashMap: Map<number, { sig: string | null; body: string | null }>,
): void {
  const symIdMap = symIdMapByFile.get(file.path) ?? new Map<string, number>();

  const sortedSymbols = [...file.symbols]
    .filter((s) => ['class', 'function', 'interface', 'method'].includes(s.kind))
    .sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER));

  const fileLines = file.content.split(/\r?\n/);
  const skippedSymbols: SkippedSymbolGroup[] = [];

  const globalContext = [
    `File: ${file.path}`,
    file.summary ? `Summary: ${file.summary}` : '',
    file.concepts.length ? `Concepts: ${file.concepts.join(', ')}` : '',
  ].filter(Boolean).join(' | ');

  for (let i = 0; i < sortedSymbols.length; i++) {
    const sym = sortedSymbols[i];
    const symDbId = symIdMap.get(`${sym.kind}:${sym.name}`);
    if (!symDbId) continue;

    appendSigCandidate(candidates, db, project, file.path, sym, symDbId, globalContext, symHashMap);

    if (sym.line === null || sym.line === undefined) continue;

    const lineStart = Math.max(0, sym.line - 1);
    const symEndLine = (sym as { end_line?: number }).end_line;
    let lineEnd: number;
    if (symEndLine) {
      lineEnd = Math.min(fileLines.length, symEndLine);
    } else {
      const nextSym = sortedSymbols[i + 1];
      const nextLine = nextSym?.line ?? fileLines.length + 1;
      lineEnd = Math.min(fileLines.length, nextLine - 1);
    }
    const spanLines = lineEnd - lineStart;
    if (spanLines < MIN_BODY_LINES) {
      skippedSymbols.push({ sym, symDbId, lineStart, lineEnd });
      continue;
    }

    appendBodyCandidate(candidates, db, project, file.path, sym, symDbId, globalContext, fileLines, lineStart, lineEnd, symHashMap);
  }

  // cAST Sibling Merging — group small adjacent siblings into one body chunk.
  if (skippedSymbols.length > 0) {
    mergeSiblings(candidates, db, project, file.path, skippedSymbols, fileLines, globalContext, symHashMap);
  }
}

function appendSigCandidate(
  candidates: EmbeddingCandidate[],
  db: CodeIndexDB,
  project: { id: number; name: string },
  filePath: string,
  sym: CandidateSymbol,
  symDbId: number,
  globalContext: string,
  symHashMap: Map<number, { sig: string | null; body: string | null }>,
): void {
  const sigText = [
    `[Context: ${globalContext}]`,
    `${sym.kind}: ${sym.name}`,
    sym.signature ? `Signature: ${sym.signature}` : '',
    sym.comment ? `Description: ${sym.comment}` : '',
  ].filter(Boolean).join('\n').slice(0, 1000);

  const sigHash = createHash('md5').update(sigText).digest('hex');
  const symVecId = 's_' + createHash('md5').update(`${project.id}:${filePath}:${sym.name}`).digest('hex').slice(0, 24);
  const storedSigHash = symHashMap.get(symDbId)?.sig ?? null;

  if (storedSigHash !== sigHash) {
    candidates.push({
      text: sigText,
      id: symVecId,
      filePath,
      metadata: { project_name: project.name, type: 'symbol', ref_id: String(symDbId) },
      hash: sigHash,
      onCommit: () => db.setSymbolEmbeddingHash(symDbId, sigHash, 'sig', project.id),
    });
  }
}

function appendBodyCandidate(
  candidates: EmbeddingCandidate[],
  db: CodeIndexDB,
  project: { id: number; name: string },
  filePath: string,
  sym: CandidateSymbol,
  symDbId: number,
  globalContext: string,
  fileLines: string[],
  lineStart: number,
  lineEnd: number,
  symHashMap: Map<number, { sig: string | null; body: string | null }>,
): void {
  const fullBody = fileLines.slice(lineStart, lineEnd).join('\n');
  const windows = slidingWindows(fullBody, {
    windowChars: MAX_BODY_CHARS,
    overlapChars: BODY_OVERLAP_CHARS,
    maxChunks: MAX_BODY_CHUNKS,
  });
  const header = `[Context: ${globalContext}]\n${sym.kind} ${sym.name}\n${sym.signature ?? ''}\n---\n`;
  // Single-window case is byte-identical to the pre-windowing text+hash, so
  // unchanged small symbols never re-embed. Multi-window adds a part marker.
  const chunkTexts = windows.map((w, i) =>
    windows.length > 1 ? `${header}(part ${i + 1}/${windows.length})\n${w}` : `${header}${w}`,
  );

  // One combined hash gates the whole body: any window change re-emits all
  // windows. It lives in the symbol's single body-hash slot.
  const combinedHash = createHash('md5').update(chunkTexts.join(' ')).digest('hex');
  const storedBodyHash = symHashMap.get(symDbId)?.body ?? null;
  if (storedBodyHash === combinedHash) return;

  // Only the LAST window carries the real hash commit (others are no-ops).
  // Candidates are pushed contiguously and batch slicers keep a groupKey
  // together, so the commit only runs once its whole group upserted. If a
  // batch fails, the hash is never written and every window re-emits on the
  // next run (self-healing). With the old all-windows commit, a failure
  // after the first batch persisted the hash while windows were missing
  // from the store, and the incremental check then trusted that gap forever.
  const groupKey = `body:${symDbId}`;
  const bodyChunkId = (i: number): string => {
    // Chunk 0 keeps the historical id (no suffix) so it overwrites the old
    // single vector in place — no mass re-orphaning on the first reindex.
    const idSeed = i === 0
      ? `${project.id}:${filePath}:${sym.name}:body`
      : `${project.id}:${filePath}:${sym.name}:body:${i}`;
    return 'sb_' + createHash('md5').update(idSeed).digest('hex').slice(0, 23);
  };
  // Ids of windows this body USED to have but no longer does (deterministic
  // up to the configured max). Carried on the last chunk so the executor
  // cleans them after the new windows landed.
  const supersededIds: string[] = [];
  for (let j = chunkTexts.length; j < MAX_BODY_CHUNKS; j++) supersededIds.push(bodyChunkId(j));

  chunkTexts.forEach((text, i) => {
    const isLast = i === chunkTexts.length - 1;
    candidates.push({
      text,
      id: bodyChunkId(i),
      filePath,
      metadata: {
        project_name: project.name,
        type: 'symbol_body',
        ref_id: String(symDbId),
        chunk_index: String(i),
      },
      hash: combinedHash,
      groupKey,
      ...(isLast && supersededIds.length > 0 ? { supersededIds } : {}),
      onCommit: isLast
        ? () => db.setSymbolEmbeddingHash(symDbId, combinedHash, 'body', project.id)
        : () => { /* committed by the last window of the group */ },
    });
  });
}

function mergeSiblings(
  candidates: EmbeddingCandidate[],
  db: CodeIndexDB,
  project: { id: number; name: string },
  filePath: string,
  skippedSymbols: SkippedSymbolGroup[],
  fileLines: string[],
  globalContext: string,
  symHashMap: Map<number, { sig: string | null; body: string | null }>,
): void {
  skippedSymbols.sort((a, b) => a.lineStart - b.lineStart);
  let currentGroup: SkippedSymbolGroup[] = [];
  let groupChars = 0;

  const flush = () => {
    if (currentGroup.length === 0) return;
    const first = currentGroup[0];
    const last = currentGroup[currentGroup.length - 1];
    const totalLines = last.lineEnd - first.lineStart;
    if (totalLines < GROUP_MIN_LINES) return;

    const bodyParts = currentGroup.map((item) => {
      const slice = fileLines.slice(item.lineStart, item.lineEnd).join('\n');
      return `method ${item.sym.name}: ${item.sym.signature ?? '()'}\n---\n${slice}`;
    });
    const bodyText = `[Context: ${globalContext}]\n[group] File: ${filePath} (parent: ${first.sym.parent ?? 'None'})\n\n${bodyParts.join('\n\n')}`;
    const bodyHash = createHash('md5').update(bodyText).digest('hex');
    const sgVecId = 'sg_' + createHash('md5')
      .update(`${project.id}:${filePath}:${first.sym.name}:${last.sym.name}`)
      .digest('hex').slice(0, 22);
    const anchorSymDbId = first.symDbId;
    const storedBodyHash = symHashMap.get(anchorSymDbId)?.body ?? null;
    if (storedBodyHash === bodyHash) return;

    candidates.push({
      text: bodyText.slice(0, MAX_BODY_CHARS),
      id: sgVecId,
      filePath,
      metadata: { project_name: project.name, type: 'symbol_group', ref_id: String(anchorSymDbId) },
      hash: bodyHash,
      onCommit: () => db.setSymbolEmbeddingHash(anchorSymDbId, bodyHash, 'body', project.id),
    });
  };

  for (const item of skippedSymbols) {
    if (currentGroup.length === 0) {
      currentGroup.push(item);
      groupChars += (item.lineEnd - item.lineStart) * 50;
      continue;
    }
    const prev = currentGroup[currentGroup.length - 1];
    const gap = item.lineStart - prev.lineEnd;
    const sameParent = item.sym.parent === prev.sym.parent;
    if (gap <= SIBLING_GAP && sameParent && groupChars < MAX_BODY_CHARS) {
      currentGroup.push(item);
      groupChars += (item.lineEnd - item.lineStart) * 50;
    } else {
      flush();
      currentGroup = [item];
      groupChars = (item.lineEnd - item.lineStart) * 50;
    }
  }
  flush();
}
