import type { SearchMode } from '@ctx/shared/types.js';

/**
 * Search planner — chooses the cheapest backend that's likely to answer
 * a given query well, instead of paying the full hybrid cost on every
 * call.
 *
 * Defaulting `HybridSearch` to `mode='hybrid'` meant a 500 ms vector
 * round-trip for queries like `parseIdParam` that FTS resolves in
 * 10 ms with higher recall. The planner fixes that by inspecting the
 * query *shape* (it does NOT call an LLM) and emitting a routing
 * decision the search layer can act on.
 *
 *   identifier-shape  → `fts`        (symbol name, function call)
 *   short token list  → `fts`        (1-3 CamelCase / snake_case)
 *   natural language  → `hybrid`     (full sentence, contains stopwords)
 *   question form     → `hybrid`     (starts with how/why/what/where)
 *
 * The decision is returned alongside a short reason so diagnostics can
 * surface it in the dashboard. Future iterations can swap reasons for
 * confidence scores or A/B alternative plans.
 */

export interface RetrievalPlan {
  mode: Exclude<SearchMode, 'auto'>;
  reason: string;
}

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const QUALIFIED_CALL_RE = /^[A-Za-z_$][\w$]*::[A-Za-z_$][\w$]*$/;
const QUESTION_RE = /\?$|^(how|why|what|where|when|which|como|por\s*que|onde|quando|qual)\b/i;

/**
 * Heuristic: tokens that look like CamelCase, snake_case, kebab-case or
 * dotted identifiers. If the query is mostly these it's a code lookup,
 * not a question.
 */
const CODEY_TOKEN_RE = /^[A-Za-z_$][\w$.-]*$/;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'do', 'does', 'of', 'to', 'in', 'on',
  'for', 'with', 'and', 'or', 'que', 'de', 'da', 'do', 'um', 'uma',
  'para', 'com', 'sem',
]);

export function planQuery(rawQuery: string): RetrievalPlan {
  const query = rawQuery.trim();
  if (query.length === 0) {
    return { mode: 'fts', reason: 'empty query' };
  }

  // Single identifier or qualified name → symbol lookup. FTS on
  // `symbols_fts` resolves these instantly with perfect recall.
  if (IDENTIFIER_RE.test(query) || QUALIFIED_CALL_RE.test(query)) {
    return { mode: 'fts', reason: 'identifier-shaped query' };
  }

  // Natural-language question → embedding-based recall pays off.
  if (QUESTION_RE.test(query)) {
    return { mode: 'hybrid', reason: 'question phrasing' };
  }

  const tokens = query.split(/\s+/).filter(Boolean);

  // Short token list of code-shaped words (e.g. "parseIdParam parseJsonBody")
  // is still a code lookup — don't pay vector cost.
  if (tokens.length > 0 && tokens.length <= 4 && tokens.every((t) => CODEY_TOKEN_RE.test(t))) {
    return { mode: 'fts', reason: 'short code-shaped tokens' };
  }

  // Sentence-ish: contains stopwords or punctuation typical of NL. Hybrid
  // + RRF is the safe default.
  const stopwordHits = tokens.filter((t) => STOPWORDS.has(t.toLowerCase())).length;
  if (stopwordHits >= 2 || tokens.length > 6) {
    return { mode: 'hybrid', reason: 'natural-language query' };
  }

  // Mixed bag — small number of words, no clear signal. Default to fts
  // because the failure mode (missed paraphrase) is recoverable; the
  // failure mode of paying for vector on every call is silent cost.
  return { mode: 'fts', reason: 'short mixed query' };
}
