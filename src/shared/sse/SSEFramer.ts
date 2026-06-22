/**
 * Pure SSE framer — parses Server-Sent Event wire format.
 *
 * Events are separated by blank lines (\n\n). Each event is a block of
 * lines with `id:`, `event:`, `data:` prefixes. `data:` may appear multiple
 * times (concatenated with newlines per spec).
 *
 * Stateless aside from the incomplete trailing buffer — callers pass the
 * accumulated buffer and receive parsed events plus the remainder.
 */

export interface SSEEvent {
  /** Numeric id if present (used for Last-Event-ID replay). */
  id?: number;
  /** Event name. Defaults to "message" per SSE spec. */
  event: string;
  /** Raw data payload (may be JSON, may be empty). */
  data: string;
}

export interface SSEParseResult {
  events: SSEEvent[];
  /** Portion of input that hasn't completed an event yet; feed back on next call. */
  rest: string;
}

/**
 * Parse a chunk of the SSE stream. Returns all complete events and the
 * unconsumed remainder. Never throws on malformed input — malformed event
 * blocks are silently dropped (matching browser EventSource behavior).
 */
export function parseSSEChunk(buffer: string): SSEParseResult {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: SSEEvent[] = [];

  for (const raw of blocks) {
    if (!raw) continue;
    const ev = parseEventBlock(raw);
    if (ev) events.push(ev);
  }

  return { events, rest };
}

function parseEventBlock(raw: string): SSEEvent | null {
  let event = 'message';
  let data = '';
  let id: number | undefined;
  let sawField = false;

  for (const rawLine of raw.split('\n')) {
    // Strip trailing \r for CRLF streams.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    if (line.startsWith(':')) continue; // comment

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // Per spec: if value starts with a single space, trim it.
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      event = value;
      sawField = true;
    } else if (field === 'data') {
      data = data ? data + '\n' + value : value;
      sawField = true;
    } else if (field === 'id') {
      const n = parseInt(value, 10);
      if (Number.isFinite(n)) id = n;
      sawField = true;
    }
    // Other fields (retry, etc) are ignored.
  }

  if (!sawField) return null;
  return { event, data, id };
}
