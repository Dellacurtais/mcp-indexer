/**
 * ReconnectingWebSocketClient — companion to `ReconnectingSSEClient`
 * but over a bidirectional WebSocket connection.
 *
 * Wire protocol (matches the server in
 * `apps/http-api/server/routes/company/ws.ts`):
 *
 *   - Frames are JSON text. Server → client carries
 *     `{ v: 1, seq, type, data }`. The legacy SSE event shape
 *     (`{ id, event, data }`) is exposed to consumers via the same
 *     `SSEEvent` type so callers can be transport-agnostic.
 *   - Heartbeat frames are `{ "type": "ping" }` and silently dropped.
 *   - Client → server frames are reserved for the future
 *     orchestrator-on-worker migration (P13). Today's clients only
 *     emit `{ "type": "ack" }` for keepalive on backgrounded tabs.
 *
 * Lifecycle parity with SSE:
 *   - `getLastEventId` → encoded as `?sinceSeq=N` query param at
 *     connect time. WebSocket has no `Last-Event-ID` HTTP header
 *     equivalent (the upgrade is just one GET) so the seq has to ride
 *     in the URL.
 *   - `onPhase` emits `connecting | replaying | live | disconnected`
 *     with the same semantics — `replaying` when reconnecting with
 *     a non-negative `sinceSeq`, `live` after the first non-ping
 *     frame arrives.
 *   - Same backoff strategy.
 */

import type { SSEEvent } from '../sse/SSEFramer.js';
import type { SSEConnectionPhase } from '../sse/ReconnectingSSEClient.js';
import { ExponentialBackoff, sleep, type BackoffStrategy } from '../sse/BackoffStrategy.js';

/**
 * Re-exported so callers don't need to reach into the SSE module just
 * to import the phase type alongside the WS client.
 */
export type { SSEConnectionPhase } from '../sse/ReconnectingSSEClient.js';

export interface ReconnectingWebSocketOpts {
  /** Target ws:// or wss:// URL (no query string — `sinceSeq` is appended). */
  url: string;
  /** Called for every non-ping frame translated to the SSE event shape. */
  onEvent: (ev: SSEEvent) => void;
  /** Fired on phase transitions for UI strips / banners. */
  onPhase?: (phase: SSEConnectionPhase) => void;
  /** Provides the latest seq for replay. Same contract as SSE's getter. */
  getLastEventId?: () => number;
  /** Invoked before each reconnect attempt (attempt >= 1). */
  onReconnect?: (attempt: number) => void | Promise<void>;
  /** AbortSignal for cancellation. */
  signal: AbortSignal;
  /** Reconnect backoff. Defaults to exponential 1s..16s, 5 tries. */
  backoff?: BackoffStrategy;
  /** Predicate marking a terminal event (defaults to `event === 'done'`). */
  isTerminal?: (ev: SSEEvent) => boolean;
}

/**
 * Minimal WebSocket constructor type. The dashboard uses the global
 * `WebSocket` (browser); Node tests can pass `ws` or any compliant
 * implementation. Decouples the client from a hard `window` reference.
 */
type WebSocketCtor = new (url: string) => WebSocketLike;

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const defaultIsTerminal = (ev: SSEEvent): boolean => ev.event === 'done';

/**
 * Resolve which WebSocket implementation to use. Browser has the
 * global `WebSocket`; Node tests can inject a fake via the
 * `WS_CONSTRUCTOR_FOR_TESTS` symbol on `globalThis`.
 */
function resolveWebSocketCtor(): WebSocketCtor {
  const fake = (globalThis as unknown as { WS_CONSTRUCTOR_FOR_TESTS?: WebSocketCtor })
    .WS_CONSTRUCTOR_FOR_TESTS;
  if (fake) return fake;
  const ctor = (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!ctor) {
    throw new Error('ReconnectingWebSocketClient: no global WebSocket available');
  }
  return ctor;
}

export class ReconnectingWebSocketClient {
  private readonly opts: ReconnectingWebSocketOpts;
  private readonly backoff: BackoffStrategy;
  private readonly isTerminal: (ev: SSEEvent) => boolean;
  private terminalSeen = false;

  constructor(opts: ReconnectingWebSocketOpts) {
    this.opts = opts;
    this.backoff = opts.backoff ?? new ExponentialBackoff();
    this.isTerminal = opts.isTerminal ?? defaultIsTerminal;
  }

  /**
   * Resolves when the terminal event arrives, when the signal aborts,
   * or — like the SSE client — when reconnect budget is exhausted.
   * Rejects only for non-recoverable errors after backoff.
   */
  async run(): Promise<void> {
    let attempt = 0;
    while (!this.opts.signal.aborted && !this.terminalSeen) {
      try {
        if (attempt > 0) await this.opts.onReconnect?.(attempt);
        await this.connectOnce();
        if (!this.terminalSeen) return;
        return;
      } catch (err) {
        if (this.opts.signal.aborted) return;
        if (this.terminalSeen) return;
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
    const ctor = resolveWebSocketCtor();
    const sinceSeq = this.opts.getLastEventId?.() ?? -1;
    const replaying = typeof sinceSeq === 'number' && sinceSeq >= 0;
    this.emitPhase(replaying ? 'replaying' : 'connecting');

    const url = appendSinceSeq(this.opts.url, replaying ? sinceSeq : -1);
    const ws = new ctor(url);
    let firstEventSeen = false;
    let resolved = false;

    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
      };

      const onAbort = (): void => {
        if (resolved) return;
        resolved = true;
        cleanup();
        try { ws.close(1000, 'abort'); } catch { /* best-effort */ }
        resolve();
      };
      if (this.opts.signal.aborted) {
        onAbort();
        return;
      }
      this.opts.signal.addEventListener('abort', onAbort, { once: true });

      ws.onmessage = (msg) => {
        const data = typeof msg.data === 'string' ? msg.data : '';
        if (!data) return;
        let parsed: { v?: number; seq?: number; type?: string; data?: unknown };
        try {
          parsed = JSON.parse(data) as typeof parsed;
        } catch {
          return; // malformed frame — drop
        }
        if (parsed.type === 'ping') return;
        if (!firstEventSeen) {
          this.emitPhase('live');
          firstEventSeen = true;
        }
        const ev: SSEEvent = {
          id: typeof parsed.seq === 'number' ? parsed.seq : undefined,
          event: typeof parsed.type === 'string' ? parsed.type : 'message',
          data: typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data ?? ''),
        };
        try {
          this.opts.onEvent(ev);
        } catch {
          /* consumer error — don't kill the stream */
        }
        if (this.isTerminal(ev)) {
          this.terminalSeen = true;
          if (!resolved) {
            resolved = true;
            cleanup();
            try { ws.close(1000, 'terminal'); } catch { /* best-effort */ }
            resolve();
          }
        }
      };

      ws.onclose = (closeEv) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        if (this.terminalSeen) return resolve();
        // 1006 (abnormal closure) is the typical "network broke" code;
        // 1011 means server-side error. Either way, let `run()` decide
        // whether to retry via its backoff loop.
        reject(
          Object.assign(new Error(`WebSocket closed (code=${closeEv.code})`), {
            wsCode: closeEv.code,
            wsReason: closeEv.reason,
          }),
        );
      };

      ws.onerror = (err) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        try { ws.close(1011, 'error'); } catch { /* best-effort */ }
        reject(err instanceof Error ? err : new Error('WebSocket error'));
      };
    });
  }
}

function appendSinceSeq(url: string, sinceSeq: number): string {
  if (sinceSeq < 0) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}sinceSeq=${sinceSeq}`;
}
