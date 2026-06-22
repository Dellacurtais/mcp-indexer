/**
 * Worker-thread entry for the embeddings backfill.
 *
 * Runs its OWN local ONNX session so the heavy initial backfill of a large repo
 * doesn't monopolize the main thread's embedding session — which the live search
 * path uses to embed incoming queries. Without this, a query's embed() call
 * queues behind the entire backfill (the local service serializes on a single
 * session), so semantic search starves until indexing finishes.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { LocalEmbeddingService } from '@ctx/indexer/search/local-embeddings.js';

const svc = new LocalEmbeddingService({ model: (workerData as { model?: string } | undefined)?.model });

parentPort?.on('message', (msg: { id: number; texts: string[] }) => {
  void (async () => {
    try {
      const { vectors } = await svc.embed(msg.texts);
      parentPort?.postMessage({ id: msg.id, vectors });
    } catch (e) {
      parentPort?.postMessage({ id: msg.id, error: e instanceof Error ? e.message : String(e) });
    }
  })();
});
