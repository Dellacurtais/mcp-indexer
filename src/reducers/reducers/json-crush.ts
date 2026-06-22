/**
 * json-crush — a CONTENT-TYPE reducer for large structured tool outputs.
 *
 * The per-tool SMART_REDUCERS (git_log, grep, run_command, …) key off the TOOL
 * NAME. But a lot of context waste comes from generic tools (MCP servers,
 * code_exec) that return big, redundant JSON arrays / NDJSON and have no
 * name-specific reducer — those fall through to a blind head-cut. This reducer
 * keys off the CONTENT TYPE instead. When a tool result is a JSON array (or
 * NDJSON) it:
 *
 *   1. drops exact-duplicate rows,
 *   2. (optionally) ranks rows by lexical overlap with the current user query,
 *   3. always keeps the first/last few rows as anchors (top results / latest),
 *   4. fills a char budget (~cap) with the highest-ranked survivors,
 *   5. emits a deterministic marker describing what was elided.
 *
 * Like every reducer it is deterministic (stable sort; the marker depends only
 * on counts, never on turn/context) and idempotent (no-op when the content
 * already fits the cap). The shaped bytes are produced once at tool-finalize
 * time and persisted, so they stay byte-stable across turns and never thrash
 * the prefix cache — even though the query-relevance step is query-dependent,
 * the reducer is never re-run on resume (that path uses buildToolResultBlock).
 *
 * Fase 1 is lossy: elided rows are gone — re-run the tool with narrower params
 * to recover. Fase 2 (wiring the dormant ToolOutputStore spill) will let the
 * marker carry an `output_id` so `get_tool_output` recovers dropped rows.
 */

export interface JsonCrushInput {
  content: string;
  cap: number;
  /** Latest user-turn text; when present, rows are ranked by overlap with it. */
  query?: string;
}

export interface JsonCrushOutput {
  content: string;
  /** True only when the reducer actually shrank the content. */
  applied: boolean;
}

/** Min rows before crushing is worthwhile (small arrays aren't the problem). */
const MIN_ROWS = 8;
/** Rows kept verbatim at each end regardless of score. */
const ANCHOR = 3;
/** Above this, bail to the blind head-cut to avoid pathological latency. */
const MAX_ROWS = 50_000;
/** Reserve for the trailing marker so the result stays near `cap`. */
const MARKER_RESERVE = 200;
/** Fraction of non-empty lines that must parse as JSON to treat as NDJSON. */
const NDJSON_MIN_RATIO = 0.8;
/** Cap on query text fed to the tokenizer (guards against giant prompts). */
const QUERY_MAX = 4000;

interface Row {
  /** Original index — drives output ordering and the stable tie-break. */
  idx: number;
  /** Serialized text used for dedup, scoring and re-emit. */
  text: string;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
}

/** Parse content into rows + the shape to re-serialize as, or null if N/A. */
function parseRows(content: string): { rows: Row[]; mode: 'array' | 'ndjson' } | null {
  const trimmed = content.trim();
  // Top-level JSON array.
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length >= MIN_ROWS && parsed.length <= MAX_ROWS) {
        return { mode: 'array', rows: parsed.map((v, idx) => ({ idx, text: JSON.stringify(v) })) };
      }
    } catch {
      /* not a single JSON array — fall through */
    }
    return null;
  }
  // NDJSON: many non-empty lines, most of which parse as JSON objects/arrays.
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length < MIN_ROWS || lines.length > MAX_ROWS) return null;
  let ok = 0;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { JSON.parse(t); ok++; } catch { /* not json */ }
    }
  }
  if (ok / lines.length < NDJSON_MIN_RATIO) return null;
  return { mode: 'ndjson', rows: lines.map((text, idx) => ({ idx, text })) };
}

export function jsonCrush({ content, cap, query }: JsonCrushInput): JsonCrushOutput {
  const pass: JsonCrushOutput = { content, applied: false };
  if (content.length <= cap) return pass;
  const parsed = parseRows(content);
  if (!parsed) return pass;
  const { rows, mode } = parsed;

  // 1. Dedup exact-duplicate rows (keep first occurrence).
  const seen = new Set<string>();
  const unique: Row[] = [];
  let duplicates = 0;
  for (const r of rows) {
    if (seen.has(r.text)) { duplicates++; continue; }
    seen.add(r.text);
    unique.push(r);
  }

  // 2. Score by lexical overlap with the query (0 when no query → order kept).
  const qtokens = query ? new Set(tokenize(query.slice(0, QUERY_MAX))) : null;
  const score = (text: string): number => {
    if (!qtokens || qtokens.size === 0) return 0;
    let hits = 0;
    for (const t of new Set(tokenize(text))) if (qtokens.has(t)) hits++;
    return hits;
  };

  // 3. Anchors: the first/last ANCHOR rows (original order) always survive.
  const keep = new Set<number>();
  for (const r of unique.slice(0, ANCHOR)) keep.add(r.idx);
  for (const r of unique.slice(Math.max(ANCHOR, unique.length - ANCHOR))) keep.add(r.idx);

  // 4. Budget fill: remaining rows by score desc, then original index asc.
  const budget = Math.max(0, cap - MARKER_RESERVE);
  let used = unique.filter((r) => keep.has(r.idx)).reduce((n, r) => n + r.text.length + 1, 0);
  const middle = unique
    .filter((r) => !keep.has(r.idx))
    .map((r) => ({ r, s: score(r.text) }))
    .sort((a, b) => b.s - a.s || a.r.idx - b.r.idx);
  for (const { r } of middle) {
    const cost = r.text.length + 1;
    if (used + cost > budget) continue;
    keep.add(r.idx);
    used += cost;
  }

  const kept = unique.filter((r) => keep.has(r.idx)).sort((a, b) => a.idx - b.idx);
  const elided = unique.length - kept.length;
  if (duplicates === 0 && elided === 0) return pass; // nothing saved

  const body = mode === 'array'
    ? '[' + kept.map((r) => r.text).join(',\n') + ']'
    : kept.map((r) => r.text).join('\n');
  const marker =
    `\n[smart-reducer: json-crush — kept ${kept.length}/${rows.length} rows` +
    (duplicates ? `; dropped ${duplicates} duplicate(s)` : '') +
    (elided ? `; elided ${elided} lower-relevance row(s) — re-run with narrower params if needed` : '') +
    `]\n`;
  const out = body + marker;
  if (out.length >= content.length) return pass; // reducer didn't help
  return { content: out, applied: true };
}
