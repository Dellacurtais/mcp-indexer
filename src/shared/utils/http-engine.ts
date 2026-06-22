/**
 * http-engine — transport + cookie-jar primitives for making real HTTP/HTTPS
 * requests against a live backend (localhost or remote).
 *
 * Pure node:http/https with ZERO workspace deps, so it lives in @ctx/shared
 * and backs three callers without creating a cycle: the `http_request`
 * CoderTool (@ctx/code-agent), the API-client "send" route (apps/http-api),
 * and the non-LLM regression runner (@ctx/services). Presentation concerns
 * (LLM body truncation, formatted result lines) stay with each caller — the
 * engine only does the request and the cookie bookkeeping.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isPrivateHost } from './ssrf.js';

/** Hard read ceiling — never buffer more than this from a single response. */
export const READ_CAP = 512 * 1024;

export interface RawResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** Total bytes the response would have had (may exceed body.length if capped). */
  size: number;
  /** True when the body was cut off at the read cap. */
  truncated: boolean;
}

// ─── Cookie jar (host → name → value) ──────────────────────────────────────
/** A single cookie jar. Callers keep their own keyed registry of jars. */
export type CookieJar = Map<string, Map<string, string>>;

export function createJar(): CookieJar {
  return new Map();
}

export function cookieHeaderFor(jar: CookieJar, host: string): string {
  const m = jar.get(host);
  if (!m || m.size === 0) return '';
  return [...m.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
}

export function storeSetCookies(jar: CookieJar, host: string, setCookie?: string[] | string): void {
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  let m = jar.get(host);
  if (!m) { m = new Map(); jar.set(host, m); }
  for (const c of list) {
    const first = c.split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) m.set(name, value);
  }
}

export function isLoopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(host);
}

/** Snapshot a jar's cookies for one host as `[{name,value}]` (for the UI). */
export function jarSnapshot(jar: CookieJar, host: string): { name: string; value: string }[] {
  const m = jar.get(host);
  if (!m) return [];
  return [...m.entries()].map(([name, value]) => ({ name, value }));
}

// ─── Transport ─────────────────────────────────────────────────────────────
export function doRequest(o: {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  insecure: boolean;
  timeoutMs: number;
  /** Max bytes to buffer from the response body. Defaults to READ_CAP. */
  maxBytes?: number;
  /** Refuse private/loopback/link-local/metadata destinations (SSRF guard). */
  blockPrivateHosts?: boolean;
  signal?: AbortSignal;
}): Promise<RawResponse> {
  const cap = o.maxBytes ?? READ_CAP;
  return new Promise((resolve, reject) => {
    const isHttps = o.url.protocol === 'https:';
    // Scheme allowlist — only http/https. Bars file:/gopher:/data: etc. explicitly
    // (node would reject most, but make the boundary intentional, not implicit).
    if (!isHttps && o.url.protocol !== 'http:') {
      reject(new Error(`unsupported URL scheme '${o.url.protocol}' (only http and https are allowed)`));
      return;
    }
    // SSRF guard (opt-in): refuse internal targets when the caller asked for it.
    if (o.blockPrivateHosts && isPrivateHost(o.url.hostname)) {
      reject(new Error(`refusing to send to private/loopback host '${o.url.hostname}'`));
      return;
    }
    const reqFn = isHttps ? httpsRequest : httpRequest;
    let settled = false;
    const fail = (e: Error): void => { if (!settled) { settled = true; reject(e); } };
    const req = reqFn(
      o.url,
      {
        method: o.method,
        headers: o.headers,
        ...(isHttps ? { rejectUnauthorized: !o.insecure } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        const finish = (truncated: boolean): void => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            size: total,
            truncated,
          });
        };
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total <= cap) { chunks.push(c); return; }
          // Cap exceeded — resolve with what we have and TEAR DOWN the transfer
          // immediately instead of draining a possibly-gigabyte response just to
          // discard the overflow (bandwidth/socket DoS). Resolve before destroy
          // so the ensuing close/error is a no-op.
          finish(true);
          res.destroy();
        });
        res.on('end', () => finish(false));
        res.on('error', (e: Error) => { if (!settled) fail(e); });
      },
    );
    req.setTimeout(o.timeoutMs, () => req.destroy(new Error(`request timed out after ${o.timeoutMs}ms`)));
    req.on('error', fail);
    if (o.body != null && o.body.length > 0) req.write(o.body);
    req.end();
  });
}

// ─── High-level send (jar-aware, used by the route + regression runner) ─────
export interface SendOptions {
  url: URL;
  method?: string;
  headers?: Record<string, string>;
  /** JSON body — serialized and sent as application/json (overrides `body`). */
  json?: unknown;
  body?: string | Buffer;
  /** Accept self-signed TLS. Defaults to true for loopback hosts. */
  insecure?: boolean;
  /** Timeout in ms — clamped to [1000, 120000]. Default 30000. */
  timeoutMs?: number;
  /** Max bytes to buffer from the response. Defaults to READ_CAP. */
  maxBytes?: number;
  /** Cookie jar to read prior cookies from and store Set-Cookie into. */
  jar?: CookieJar;
  /** Refuse private/loopback/link-local/metadata destinations (SSRF guard). */
  blockPrivateHosts?: boolean;
  signal?: AbortSignal;
}

/**
 * Apply jar cookies, serialize a JSON body, perform the request, then persist
 * any Set-Cookie back into the jar. Returns the raw response untouched.
 */
export async function sendHttp(o: SendOptions): Promise<RawResponse> {
  const method = String(o.method ?? 'GET').toUpperCase();
  const timeoutMs = Math.min(120_000, Math.max(1_000, Number(o.timeoutMs ?? 30_000)));
  const insecure = o.insecure != null ? !!o.insecure : isLoopbackHost(o.url.hostname);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers ?? {})) headers[k] = String(v);

  let body: string | Buffer | undefined;
  if (o.json !== undefined && o.json !== null) {
    body = JSON.stringify(o.json);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
  } else if (typeof o.body === 'string' || Buffer.isBuffer(o.body)) {
    body = o.body;
  }

  if (o.jar) {
    const jarCookie = cookieHeaderFor(o.jar, o.url.host);
    if (jarCookie) {
      const existing = Object.entries(headers).find(([h]) => h.toLowerCase() === 'cookie');
      headers[existing ? existing[0] : 'cookie'] = existing ? `${existing[1]}; ${jarCookie}` : jarCookie;
    }
  }

  const res = await doRequest({ url: o.url, method, headers, body, insecure, timeoutMs, maxBytes: o.maxBytes, blockPrivateHosts: o.blockPrivateHosts, signal: o.signal });
  if (o.jar) storeSetCookies(o.jar, o.url.host, res.headers['set-cookie']);
  return res;
}
