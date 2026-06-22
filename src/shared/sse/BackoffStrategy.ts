/**
 * Backoff strategy — abstracted so retry logic is pluggable and testable
 * without touching the network layer.
 */

export interface BackoffStrategy {
  /** Returns the delay in ms for the given zero-based attempt, or null if exhausted. */
  nextDelay(attempt: number): number | null;
}

export interface ExponentialBackoffOpts {
  /** Initial delay in ms (attempt 0). Default 1000. */
  baseMs?: number;
  /** Maximum delay cap in ms. Default 16000. */
  maxMs?: number;
  /** Maximum attempts before giving up. Default 5. */
  maxAttempts?: number;
  /** Multiplier between attempts. Default 2. */
  factor?: number;
}

/**
 * Exponential backoff: base * factor^attempt, capped at maxMs, ending
 * after maxAttempts. attempt=0 sleeps baseMs before the first retry.
 */
export class ExponentialBackoff implements BackoffStrategy {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly maxAttempts: number;
  private readonly factor: number;

  constructor(opts: ExponentialBackoffOpts = {}) {
    this.baseMs = opts.baseMs ?? 1000;
    this.maxMs = opts.maxMs ?? 16_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.factor = opts.factor ?? 2;
  }

  nextDelay(attempt: number): number | null {
    if (attempt >= this.maxAttempts) return null;
    const delay = this.baseMs * Math.pow(this.factor, attempt);
    return Math.min(delay, this.maxMs);
  }
}

/** Sleep helper that honors an AbortSignal. Rejects with AbortError when aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
