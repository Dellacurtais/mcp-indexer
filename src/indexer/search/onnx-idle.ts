/**
 * Idle-TTL resolution shared by the local ONNX services (embeddings +
 * reranker). After this long without a call, the ONNX session is released
 * (native memory actually returns to the OS — `session.release()` via
 * transformers.js dispose) and transparently re-created on next use.
 *
 * Default 10min: IDE searches come in bursts (an investigation session lasts
 * minutes); ten quiet minutes means the burst is over, and the pair of
 * models (~100-300MB+) goes back to the OS for the rest of a long desktop
 * session. The cost of coming back is a model reload from local disk
 * (~1-8s, no network). Default lives in code; `MCP_ONNX_IDLE_TTL_MS` is the
 * operator override, 0 = never unload.
 */
export const DEFAULT_ONNX_IDLE_TTL_MS = 10 * 60_000;

export function resolveOnnxIdleTtlMs(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const raw = Number(process.env.MCP_ONNX_IDLE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_ONNX_IDLE_TTL_MS;
}
