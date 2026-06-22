/**
 * Dev-server URL detection — shared between the dashboard (live preview
 * hook) and the Electron main (agent preview resolver), so both parse a
 * runner's terminal output the same way.
 *
 * Two-tier match: a URL on a "ready/listening" line is the server's OWN
 * address (authoritative). A bare URL is provisional — dev scripts often
 * echo config/proxy targets first (`VITE_API_URL=http://localhost:8282`),
 * and taking the first URL made the preview attach to ANOTHER service.
 */

export const DEV_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i;

/**
 * Lines that announce the server's own address: vite "Local:", wrangler
 * "Ready on", next "started server", CRA, angular, fastify, "➜", "on port".
 */
export const DEV_READY_LINE_RE =
  /(local:|ready|listening|running at|started server|server (running|started|listening)|available (at|on)|➜|on port)/i;

/** Minimal shape of a terminal-output chunk (PtyEntry buffer / SSE stream). */
export interface DevOutputChunk {
  type: string;
  data?: string;
}

export interface DevUrlMatch {
  /** `http://localhost:PORT` or null when nothing matched yet. */
  url: string | null;
  /** True when the URL came from a "ready/listening" line (final). */
  authoritative: boolean;
}

/**
 * Scan accumulated terminal chunks for the dev server URL. Returns the
 * authoritative match if any ready-line URL exists; otherwise the first
 * provisional bare URL; otherwise `{ url: null }`.
 */
export function extractDevUrl(chunks: readonly DevOutputChunk[]): DevUrlMatch {
  let provisional: string | null = null;
  for (const chunk of chunks) {
    if (chunk.type !== 'data' || !chunk.data) continue;
    for (const line of chunk.data.split(/\r?\n/)) {
      const m = DEV_URL_RE.exec(line);
      if (!m) continue;
      const url = `http://localhost:${m[1]}`;
      if (DEV_READY_LINE_RE.test(line)) return { url, authoritative: true };
      if (!provisional) provisional = url;
    }
  }
  return { url: provisional, authoritative: false };
}

/**
 * Heuristic: does this runner command/label look like a long-running
 * dev/preview server (so we can surface a live preview)? Broad on purpose
 * — a false positive just shows an empty preview, never breaks anything.
 */
const DEV_SERVER_CMD_RE =
  /(^|[\s:/])(dev|serve|preview|start|watch|wrangler|vite|http-server|live-server)([\s:]|$)/i;

export function isDevServerCommand(command: string, label?: string): boolean {
  return DEV_SERVER_CMD_RE.test(command) || DEV_SERVER_CMD_RE.test(label ?? '');
}
