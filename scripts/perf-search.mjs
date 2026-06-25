/**
 * Search performance + token-economy baseline. Runs a fixed query set against the
 * real index (in-process via searchWithDiag) and reports, per query/mode:
 * planner route, cold/warm latency (cache), raw vs final result count (shows the
 * language-filter over-fetch), output bytes (token economy), and the FTS/vector/
 * content/variant diagnostic counts. Plus project coverage/stale.
 *
 *   MCP_DATA_DIR=<index store> EVAL_REPO=<repo> node scripts/perf-search.mjs [--json]
 *   (defaults: EVAL_REPO=D:/code-context)
 *
 * Reuses hybridSearch.searchWithDiag — zero new infra. Mirrors the search tool's
 * over-fetch (limit*5 on a language filter), post-filter, and rendering so the
 * numbers match what the agent actually receives.
 */
import { openProject } from '../dist/cli/commands/shared.js';
import { languageIdForPath } from '../dist/shared/utils/language-id.js';

const REPO = process.env.EVAL_REPO || 'D:/code-context';
const AS_JSON = process.argv.includes('--json');
const LIMIT = 20;

const QUERIES = [
  { q: 'BedrockReranker', mode: 'auto', note: 'identifier→fts' },
  { q: 'resolveAllowlist', mode: 'auto', note: 'identifier→fts' },
  { q: 'how does output capping work', mode: 'auto', note: 'NL→hybrid/vector' },
  { q: 'where are MCP tools registered', mode: 'auto', note: 'NL→hybrid/vector' },
  { q: 'output capping', mode: 'fts', note: '2-word, 1 common (OR-flood)' },
  { q: 'reranker', mode: 'auto', langs: ['typescript'], note: 'language filter (over-fetch)' },
];

const toLangSet = (v) => new Set((v ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));

/** Faithful copy of the search tool's body rendering (src/mcp/tools/search.ts). */
function renderBody(results) {
  return results
    .map((r) => {
      const d = r.data;
      if (r.type === 'file') {
        let concepts = '';
        try { concepts = JSON.parse(d.concepts ?? '[]').join(', '); } catch { /* ignore */ }
        return [
          `## [file] ${d.path} (score: ${r.score.toFixed(3)})`,
          `Language: ${d.language} | Lines: ${d.line_count} | Complexity: ${d.complexity}${d.layer && d.layer !== 'unknown' ? ` | Layer: ${d.layer}` : ''}`,
          `Summary: ${d.summary ?? ''}`,
          concepts ? `Concepts: ${concepts}` : '',
        ].filter(Boolean).join('\n');
      }
      return [
        `## [symbol] ${d.name} (${d.kind}) — score: ${r.score.toFixed(3)}`,
        `File: ${d.file_path}:${d.line ?? '?'}`,
        `Signature: ${d.signature ?? ''}`,
        d.comment ? `Description: ${d.comment}` : '',
        d.parent ? `Parent: ${d.parent}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

function langFilter(results, include, exclude) {
  if (include.size === 0 && exclude.size === 0) return results;
  return results.filter((r) => {
    const d = r.data;
    const p = String((r.type === 'file' ? d.path : d.file_path) ?? '');
    const lang = (r.type === 'file' && typeof d.language === 'string' ? d.language : languageIdForPath(p)).toLowerCase();
    if (include.size > 0 && !include.has(lang)) return false;
    if (exclude.has(lang)) return false;
    return true;
  });
}

const opened = openProject(REPO, {});
const { db, project, ctx } = opened;
const hs = ctx.hybridSearch;

const rows = [];
for (const { q, mode, langs, note } of QUERIES) {
  const include = toLangSet(langs);
  const hasLang = include.size > 0;
  const fetchLimit = hasLang ? Math.min(LIMIT * 5, 100) : LIMIT;
  const opts = { mode, type: 'all', limit: fetchLimit };

  const t0 = performance.now();
  const { results: rawCold, diagnostics: diag } = await hs.searchWithDiag(project.id, project.name, q, opts);
  const coldMs = performance.now() - t0;

  const t1 = performance.now();
  await hs.searchWithDiag(project.id, project.name, q, opts); // cache hit
  const warmMs = performance.now() - t1;

  const final = langFilter(rawCold, include, toLangSet()).slice(0, LIMIT);
  const outBytes = Buffer.byteLength(renderBody(final));

  rows.push({
    query: q,
    mode,
    note,
    route: diag.plannerMode ?? mode,
    cold_ms: +coldMs.toFixed(1),
    warm_ms: +warmMs.toFixed(1),
    raw: rawCold.length,
    final: final.length,
    overfetch: hasLang ? rawCold.length - final.length : 0,
    out_bytes: outBytes,
    fts: diag.ftsCount ?? 0,
    content: diag.contentCount ?? 0,
    vec_raw: diag.vectorRawMatches ?? 0,
    vec_hyd: diag.vectorRehydrated ?? 0,
    variants: (diag.queryVariants ?? []).length,
  });
}

const cov = db.getEmbeddingCoverage(project.id);
const stale = db.countSemanticStale(project.id);
const pct = (e, t) => (t > 0 ? Math.round((e / t) * 100) : 0);
const coverage = {
  files_pct: pct(cov.files_embedded, cov.files_total),
  symbols_pct: pct(cov.symbols_embedded, cov.symbols_total),
  bodies_pct: pct(cov.symbol_bodies_embedded, cov.symbol_bodies_total),
  semantic_stale: stale,
};

opened.db.close();

if (AS_JSON) {
  console.log(JSON.stringify({ coverage, rows }, null, 2));
} else {
  console.log(`coverage: files ${coverage.files_pct}% · symbols ${coverage.symbols_pct}% · bodies ${coverage.bodies_pct}% · stale ${coverage.semantic_stale}\n`);
  const cols = ['query', 'mode', 'route', 'cold_ms', 'warm_ms', 'raw', 'final', 'overfetch', 'out_bytes', 'fts', 'content', 'vec_raw', 'vec_hyd', 'variants'];
  console.log(cols.join('\t'));
  for (const r of rows) console.log(cols.map((c) => r[c]).join('\t'));
}
