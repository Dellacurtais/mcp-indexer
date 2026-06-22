/**
 * Two-tower cosine / dot-product similarity scorer.
 *
 * Translated from the Phoenix two-tower retrieval pattern in
 * `phoenix/recsys_retrieval_model.py:160-389`. The L2-normalization step
 * makes dot product equivalent to cosine similarity, which is what Phoenix
 * uses at serving time.
 *
 * Usage: produce a `queryEmbedding` (the user/task tower output) and a
 * batch of `candidateEmbeddings` (the item/role tower output), call
 * `cosineSimilarities(...)` to get one score per candidate.
 */

/** L2-normalize a vector in place. */
export function l2NormalizeInPlace(vec: Float32Array | number[]): void {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0 || !Number.isFinite(norm)) return;
  for (let i = 0; i < vec.length; i++) (vec as number[])[i] = vec[i] / norm;
}

/** Return a normalized COPY of the input. */
export function l2Normalize(vec: Float32Array | number[]): Float32Array {
  const out = new Float32Array(vec);
  l2NormalizeInPlace(out);
  return out;
}

/** Dot product of two equally-sized vectors. */
export function dot(a: Float32Array | number[], b: Float32Array | number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Cosine similarity of two vectors (no pre-normalization required). */
export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dotP = 0;
  let aSq = 0;
  let bSq = 0;
  for (let i = 0; i < a.length; i++) {
    dotP += a[i] * b[i];
    aSq += a[i] * a[i];
    bSq += b[i] * b[i];
  }
  const denom = Math.sqrt(aSq) * Math.sqrt(bSq);
  if (denom === 0) return 0;
  return dotP / denom;
}

/**
 * Score each candidate against a single query. If `queryEmbedding` is
 * already L2-normalized, pass `normalizedQuery=true` to skip re-normalization.
 *
 * **Candidate isolation**: each candidate's score depends ONLY on the query
 * — never on other candidates — so this is safely cacheable. This matches
 * the `make_recsys_attn_mask` invariant in `phoenix/grok.py:39-71`.
 */
export function cosineSimilarities(
  queryEmbedding: Float32Array | number[],
  candidateEmbeddings: ReadonlyArray<Float32Array | number[]>,
  options: { normalizedQuery?: boolean; normalizedCandidates?: boolean } = {},
): number[] {
  const q = options.normalizedQuery ? queryEmbedding : l2Normalize(queryEmbedding);
  const scores: number[] = new Array(candidateEmbeddings.length);
  for (let i = 0; i < candidateEmbeddings.length; i++) {
    const c = options.normalizedCandidates ? candidateEmbeddings[i] : l2Normalize(candidateEmbeddings[i]);
    scores[i] = dot(q, c);
  }
  return scores;
}
