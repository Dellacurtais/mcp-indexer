/**
 * Client for the embeddings backfill worker (embed-worker.ts). Correlates
 * request/response by id and exposes an `embed(texts)` matching the inline path,
 * so the backfill can transparently route batches to the worker's ONNX session.
 */
import { Worker } from 'node:worker_threads';

interface WorkerReply {
  id: number;
  vectors?: number[][];
  error?: string;
}

export class EmbedWorkerClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (v: { vectors: number[][] }) => void; reject: (e: Error) => void }
  >();

  constructor(model?: string) {
    const url = new URL('./embed-worker.js', import.meta.url);
    // Forward execArgv so the worker runs under the same loader (e.g. tsx in dev);
    // for a compiled dist entry execArgv is empty, so this is a no-op there.
    this.worker = new Worker(url, { workerData: { model }, execArgv: process.execArgv });
    this.worker.on('message', (m: WorkerReply) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve({ vectors: m.vectors ?? [] });
    });
    this.worker.on('error', (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
  }

  embed(texts: string[]): Promise<{ vectors: number[][] }> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, texts });
    });
  }

  async dispose(): Promise<void> {
    await this.worker.terminate();
  }
}
