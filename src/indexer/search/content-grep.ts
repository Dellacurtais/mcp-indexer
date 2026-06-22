/**
 * Token extraction for the content-index grep pre-filter.
 *
 * `file_contents_fts` is a word index (unicode61): `_`/punctuation split
 * tokens, camelCase does NOT. That means token candidates are NOT a complete
 * superset of regex matches (literal `Change` appears inside the stored token
 * `handlechange`), so callers must NEVER treat "not a candidate" as "cannot
 * match" — the contract is: scan candidates FIRST (bm25-ranked, densest files
 * up front), short-circuit only when the result cap is already reached, and
 * otherwise finish with the remaining files. Exactness preserved; the index
 * only buys ordering + early exit.
 */

const MAX_TOKENS = 8;
const MIN_TOKEN_LEN = 3;

export function extractFtsTokens(pattern: string, literal: boolean): string[] {
  // For regex patterns, drop escape classes so `\bfoo\d+` yields just `foo`.
  const source = literal ? pattern : pattern.replace(/\\[dDwWsSbB]/g, ' ');
  const raw = source.match(/[A-Za-z0-9_]+/g) ?? [];
  const tokens = new Set<string>();
  for (const chunk of raw) {
    // unicode61 treats `_` as a separator — mirror it so `foo_bar` queries
    // the same tokens the indexer stored.
    for (const part of chunk.split(/_+/)) {
      if (part.length >= MIN_TOKEN_LEN) tokens.add(part.toLowerCase());
    }
  }
  return [...tokens].slice(0, MAX_TOKENS);
}

/**
 * FTS5 MATCH expression for the pre-filter, or null when the pattern has no
 * usable token (pure punctuation/regex). Literal patterns need every token on
 * the same line → AND (still a superset of true matches); regex alternations
 * don't co-occur → OR. Prefix-star widens each token to suffixed identifiers
 * (`change*` → changes/changed/changeset).
 */
export function buildContentMatchQuery(pattern: string, literal: boolean): string | null {
  const tokens = extractFtsTokens(pattern, literal);
  if (tokens.length === 0) return null;
  const parts = tokens.map((t) => `${t}*`);
  return parts.join(literal ? ' AND ' : ' OR ');
}
