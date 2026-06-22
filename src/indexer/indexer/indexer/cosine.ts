/**
 * Cosine similarity between two equal-length Float32Array vectors. Returns 0
 * for mismatched dimensions or zero-norm vectors so downstream comparisons
 * naturally treat them as "no match".
 */
export function cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
