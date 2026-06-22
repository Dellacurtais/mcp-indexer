/**
 * Per-run phase timings + peak-RSS sampling for `indexProject`.
 *
 * Wraps each pipeline phase (scan / analyze / embed / sweep) and samples
 * `process.memoryUsage().rss` on an unref'd interval plus at every phase
 * boundary (so short runs still get a real peak).
 *
 * Honest limitations, by design:
 *  - RSS is the SERVER PROCESS's (that's what matters for the desktop app);
 *    worker-pool threads share the process, but a future child process
 *    would not be counted.
 *  - mmap'd SQLite pages (db pragmas) count toward RSS but are reclaimable
 *    page cache — compare peaks only across equal configurations.
 */

import type { RunPhaseTelemetry } from '@ctx/shared/types.js';

export type PhaseName = 'scan' | 'analyze' | 'embed' | 'sweep';
export type { RunPhaseTelemetry };

/**
 * End-of-run RSS warning threshold. Above this, the run log flags a
 * possible leak (dispose paths, ONNX sessions, worker pools). Default in
 * code; `MCP_RSS_WARN_MB` is the operator override.
 */
const DEFAULT_RSS_WARN_MB = 2048;

export function resolveRssWarnMb(): number {
  const raw = Number(process.env.MCP_RSS_WARN_MB);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_RSS_WARN_MB;
}

export interface RunTelemetry {
  /** Time `fn` under `name`. Re-entrant per phase (durations accumulate). */
  phase<T>(name: PhaseName, fn: () => Promise<T>): Promise<T>;
  /** Stop the sampler and freeze the numbers. MUST be called (clears the interval). */
  finish(): RunPhaseTelemetry;
  /** One-line human summary for the run log. */
  summary(): string;
}

const rssMb = (): number => Math.round(process.memoryUsage().rss / 1e6);

export function createRunTelemetry(opts?: { sampleIntervalMs?: number }): RunTelemetry {
  const timings: Record<PhaseName, number> = { scan: 0, analyze: 0, embed: 0, sweep: 0 };
  let peak = rssMb();
  const sample = (): void => { peak = Math.max(peak, rssMb()); };
  const timer = setInterval(sample, opts?.sampleIntervalMs ?? 500);
  timer.unref?.();
  let finished = false;

  return {
    async phase<T>(name: PhaseName, fn: () => Promise<T>): Promise<T> {
      const t0 = performance.now();
      sample();
      try {
        return await fn();
      } finally {
        timings[name] += performance.now() - t0;
        sample();
      }
    },
    finish(): RunPhaseTelemetry {
      if (!finished) {
        finished = true;
        clearInterval(timer);
        sample();
      }
      return {
        scan_ms: Math.round(timings.scan),
        analyze_ms: Math.round(timings.analyze),
        embed_ms: Math.round(timings.embed),
        sweep_ms: Math.round(timings.sweep),
        peak_rss_mb: peak,
      };
    },
    summary(): string {
      const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
      return `scan ${s(timings.scan)} | analyze ${s(timings.analyze)} | embed ${s(timings.embed)} | sweep ${s(timings.sweep)} | peak RSS ${peak}MB`;
    },
  };
}
