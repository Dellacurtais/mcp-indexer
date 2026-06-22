/**
 * Shared reranker contract types.
 *
 * Extracted from reranker.ts so concrete services (e.g. ./local-reranker.ts)
 * can implement the interface WITHOUT importing the factory module — which
 * imports them back, forming a (type-only but lint-flagged) import cycle.
 * reranker.ts re-exports these for backward compatibility.
 */

export interface RerankCandidate {
  /** Unique identifier (e.g., "file:42" or "symbol:78") */
  id: string;
  /** Text content to score against the query */
  text: string;
  /** Original score from RRF (preserved for tie-breaking) */
  originalScore: number;
}

export interface RerankResult {
  id: string;
  score: number;
  originalScore: number;
}

export interface RerankerService {
  readonly name: string;
  /**
   * Re-rank candidates by relevance to the query.
   * Returns candidates sorted by score descending.
   */
  rerank(query: string, candidates: RerankCandidate[], topK?: number): Promise<RerankResult[]>;
  /**
   * Release process-held resources (local ONNX sessions). Optional —
   * network rerankers and the Null passthrough have nothing to free.
   * Implementations must tolerate further calls after dispose.
   */
  dispose?(): Promise<void>;
}
