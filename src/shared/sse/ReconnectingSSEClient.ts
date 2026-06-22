/**
 * ReconnectingSSEClient — resilient SSE consumer.
 *
 * Single implementation used by every dashboard hook that reads an SSE
 * stream (coder, company). Handles:
 *   - Parsing via SSEFramer (DRY)
 *   - Last-Event-ID tracking (callers provide a getter so they can persist
 *     the last seen seq across reconnects)
 *   - Automatic reconnect with pluggable backoff when the stream drops
 *     before a terminal event
 *   - Heartbeat events (`event: ping`) are silently discarded
 *   - AbortSignal support for clean cancellation
 *
 * Completes successfully when the stream emits an event deemed terminal
 * by the caller (default: `event === 'done'`), or when the signal aborts.
 * Throws only for non-recoverable errors after backoff is exhausted.
 */

import { parseSSEChunk, type SSEEvent } from './SSEFramer.js';
import { ExponentialBackoff, sleep, type BackoffStrategy } from './BackoffStrategy.js';

/**
 * Lifecycle phase of the SSE client. The UI uses this to distinguish
 * a healthy live stream from a freshly-opened replay (where we sent
 * Last-Event-ID and the server is catching us up) and from a broken
 * disconnect that's about to backoff-retry.
 *
 * Transitions:
 *   - `connecting` on every `connectOnce()` start (no Last-Event-ID OR initial open)
 *   - `replaying` when Last-Event-ID is being sent (reconnect with state)
 *   - `live` after the first event arrives over the open stream
 *   - `disconnected` when the connection breaks mid-stream (before the next retry)
 */
export type SSEConnectionPhase = 'connecting' | 'replaying' | 'live' | 'disconnected';

export interface ReconnectingSSEOpts {
  /** Target URL for the request. */
  url: string;
  /** HTTP method. POST uses `body`. */
  method: 'GET' | 'POST';
  /** JSON body for POST. Ignored for GET. */
  body?: unknown;
  /** Called for every non-ping, non-empty event. Synchronous. */
  onEvent: (ev: SSEEvent) => void;
  /** Invoked before each reconnect attempt (attempt >= 1). */
  onReconnect?: (attempt: number) => void | Promise<void>;
  /**
   * Fired on every phase transition. Use to drive a "Reconnecting…
   * replaying events" UI strip. Calls are best-effort — exceptions
   * inside the handler are swallowed so they don't break the stream.
   */
  onPhase?: (phase: SSEConnectionPhase) => void;
  /** Returns the latest seen event id for Last-Event-ID on reconnect. */
  getLastEventId?: () => number;
  /** AbortSignal for cancellation. */
  signal: AbortSignal;
  /** Backoff for reconnect attempts. Defaults to exponential 1s..16s, 5 tries. */
  backoff?: BackoffStrategy;
  /** Predicate marking a terminal event. Default: `event === 'done'`. */
  isTerminal?: (ev: SSEEvent) => boolean;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

const defaultIsTerminal = (ev: SSEEvent) => ev.event === 'done';

export class ReconnectingSSEClient {
  private readonly opts: ReconnectingSSEOpts;
  private readonly backoff: BackoffStrategy;
  private readonly isTerminal: (ev: SSEEvent) => boolean;
  private terminalSeen = false;

  constructor(opts: ReconnectingSSEOpts) {
    this.opts = opts;
    this.backoff = opts.backoff ?? new ExponentialBackoff();
    this.isTerminal = opts.isTerminal ?? defaultIsTerminal;
  }

  /**
   * Runs the client. Resolves when terminal event received or signal aborted.
   * Rejects only when reconnect budget is exhausted without success.
   */
  async run(): Promise<void> {
    let attempt = 0;
    while (!this.opts.signal.aborted && !this.terminalSeen) {
      try {
        if (attempt > 0) {
          await this.opts.onReconnect?.(attempt);
        }
        await this.connectOnce();
        // If we got here without throwing and without a terminal event,
        // the server closed the stream gracefully (e.g., bus ended). Treat
        // as terminal to avoid reconnect loops.
        if (!this.terminalSeen) return;
        return;
      } catch (err) {
        if (this.opts.signal.aborted) return;
        if (this.terminalSeen) return;
        if (isAbortError(err)) return;
        if ((err as { nonRetryable?: boolean }).nonRetryable) throw err;

        // Phase: connection broke mid-stream. The next iteration of the
        // loop will re-emit `connecting`/`replaying` once the backoff
        // has elapsed.
        this.emitPhase('disconnected');

        const delay = this.backoff.nextDelay(attempt);
        if (delay === null) throw err;
        try {
          await sleep(delay, this.opts.signal);
        } catch {
          return; // aborted during backoff
        }
        attempt++;
      }
    }
  }

  private emitPhase(phase: SSEConnectionPhase): void {
    if (!this.opts.onPhase) return;
    try {
      this.opts.onPhase(phase);
    } catch {
      /* best-effort */
    }
  }

  private async connectOnce(): Promise<void> {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...(this.opts.headers ?? {}),
    };
    if (this.opts.method === 'POST') headers['Content-Type'] = 'application/json';
    const lastId = this.opts.getLastEventId?.();
    if (typeof lastId === 'number' && lastId >= 0) {
      headers['Last-Event-ID'] = String(lastId);
    }

    // Emit `replaying` when we're asking the server to catch us up;
    // otherwise this is a cold connect.
    this.emitPhase(typeof lastId === 'number' && lastId >= 0 ? 'replaying' : 'connecting');

    const res = await fetch(this.opts.url, {
      method: this.opts.method,
      headers,
      body: this.opts.method === 'POST' ? JSON.stringify(this.opts.body ?? {}) : undefined,
      signal: this.opts.signal,
    });
    if (!res.ok || !res.body) {
      // Surface the parsed JSON body alongside the status so callers can
      // route specific 4xx flavours (e.g., 409 INTERACTION_PENDING) into
      // their own UI state instead of a generic "error" toast.
      let httpBody: unknown = null;
      try {
        httpBody = await res.json();
      } catch {
        /* response body wasn't JSON */
      }
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        nonRetryable: res.status >= 400 && res.status < 500,
        status: res.status,
        httpBody,
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstEventSeen = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const { events, rest } = parseSSEChunk(buffer);
      buffer = rest;

      for (const ev of events) {
        if (ev.event === 'ping') continue;
        if (!firstEventSeen) {
          // First real event over this connection — we're live now,
          // any replay buffer has started flowing.
          this.emitPhase('live');
          firstEventSeen = true;
        }
        this.opts.onEvent(ev);
        if (this.isTerminal(ev)) {
          this.terminalSeen = true;
          try { await reader.cancel(); } catch { /* ignore */ }
          return;
        }
      }
    }
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
