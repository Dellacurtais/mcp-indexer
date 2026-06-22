import { minimatch } from 'minimatch';
import { glob as fastGlob } from 'glob';
import { defineTool, type McpTool } from '../tool.js';
import { grepInFiles } from '@ctx/services/services/code-reader.js';
import { buildContentMatchQuery } from '@ctx/indexer/search/content-grep.js';
import type { SearchMode, SearchType } from '@ctx/shared/types.js';
import { languageIdForPath } from '@ctx/shared/utils/language-id.js';
import { withProject } from './_helpers.js';

/** Normalize a languages arg (array or comma-string) to a lowercased Set. */
function toLangSet(v: unknown): Set<string> {
  const items = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v.split(',')
      : [];
  return new Set(items.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
}
import { renderDegradedTrailer, renderZeroResultDiagnostics } from './search-diagnostics.js';

const DISK_FALLBACK_MAX_FILES = 2000;
const DISK_FALLBACK_IGNORE = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  'out/**',
  '.next/**',
  '.mcp-indexer/**',
  '**/*.min.js',
  '**/*.map',
];

export async function scanDiskForGrep(rootPath: string, glob: string | undefined): Promise<string[]> {
  const pattern = glob && glob.length > 0 ? glob : '**/*';
  try {
    const matches = await fastGlob(pattern, {
      cwd: rootPath,
      nodir: true,
      dot: false,
      absolute: false,
      ignore: DISK_FALLBACK_IGNORE,
    });
    // Normalize to forward slashes (Windows) and cap.
    return matches.slice(0, DISK_FALLBACK_MAX_FILES).map(p => p.split('\\').join('/'));
  } catch {
    return [];
  }
}

const search = defineTool({
  name: 'search',
  description:
    'Search files and symbols (FTS + semantic). mode=auto routes identifier queries to FTS and natural language to hybrid. Refine to cut noise: set type="symbols" for code symbols, and languages=["typescript"] (or exclude_languages=["css","scss","html"]) to scope by language.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      query: { type: 'string' },
      mode: { type: 'string', enum: ['auto', 'fts', 'vector', 'hybrid'] },
      type: { type: 'string', enum: ['files', 'symbols', 'all'] },
      limit: { type: 'number' },
      languages: {
        type: 'array',
        items: { type: 'string' },
        description: 'keep only these languages, e.g. ["typescript"]',
      },
      exclude_languages: {
        type: 'array',
        items: { type: 'string' },
        description: 'drop these languages, e.g. ["css","scss","html"]',
      },
    },
    required: ['project_name', 'query'],
  },
  handler: withProject(async (args, { db, hybridSearch }, project) => {
    // 'auto' lets the planner route: identifier-shaped → FTS (~10ms),
    // natural language → hybrid. Forcing 'hybrid' here made every symbol
    // lookup pay HyDE + multi-variant embedding + rerank for nothing.
    const requestedMode = (args.mode as SearchMode) ?? 'auto';
    const limit = (args.limit as number) ?? 20;
    const include = toLangSet(args.languages);
    const exclude = toLangSet(args.exclude_languages);
    const hasLangFilter = include.size > 0 || exclude.size > 0;

    const { results: raw, diagnostics } = await hybridSearch.searchWithDiag(project.id, project.name, args.query as string, {
      mode: requestedMode,
      type: (args.type as SearchType) ?? 'all',
      // Over-fetch when filtering by language so enough survive to fill `limit`.
      limit: hasLangFilter ? Math.min(limit * 5, 100) : limit,
    });

    const results = hasLangFilter
      ? raw
          .filter((r) => {
            const d = r.data as unknown as Record<string, unknown>;
            const p = String((r.type === 'file' ? d.path : d.file_path) ?? '');
            const lang = (
              r.type === 'file' && typeof d.language === 'string' ? d.language : languageIdForPath(p)
            ).toLowerCase();
            if (include.size > 0 && !include.has(lang)) return false;
            if (exclude.has(lang)) return false;
            return true;
          })
          .slice(0, limit)
      : raw;

    if (results.length === 0) {
      return renderZeroResultDiagnostics(requestedMode, diagnostics, () => ({
        ...db.getEmbeddingCoverage(project.id),
        files_semantic_stale: db.countSemanticStale(project.id),
      }));
    }
    const body = results.map(r => {
      const d = r.data as unknown as Record<string, unknown>;
      if (r.type === 'file') {
        const concepts = (() => { try { return JSON.parse(d.concepts as string ?? '[]').join(', '); } catch { return ''; } })();
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
    }).join('\n\n');
    const trailer = renderDegradedTrailer(diagnostics);
    return trailer ? `${body}\n\n${trailer}` : body;
  }),
});

const search_global = defineTool({
  name: 'search_global',
  description: 'Search across all projects',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'number' } },
    required: ['query'],
  },
  handler: async (args, { db, hybridSearch }) => {
    const projects = db.listProjects();
    const allResults = [];
    for (const p of projects) {
      const results = await hybridSearch.search(p.id, p.name, args.query as string, { limit: (args.limit as number) ?? 10 });
      allResults.push(...results.map(r => ({ ...r, projectName: p.name })));
    }
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, (args.limit as number) ?? 20).map(r => {
      const d = r.data as unknown as Record<string, unknown>;
      const pName = (r as unknown as { projectName: string }).projectName;
      if (r.type === 'file') {
        return [
          `## [${pName}] [file] ${d.path} (score: ${r.score.toFixed(3)})`,
          `Language: ${d.language} | Lines: ${d.line_count} | Complexity: ${d.complexity}`,
          `Summary: ${d.summary ?? ''}`,
        ].join('\n');
      }
      return [
        `## [${pName}] [symbol] ${d.name} (${d.kind}) — score: ${r.score.toFixed(3)}`,
        `File: ${d.file_path}:${d.line ?? '?'}`,
        `Signature: ${d.signature ?? ''}`,
        d.comment ? `Description: ${d.comment}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n') || 'No results found.';
  },
});

const search_concepts = defineTool({
  name: 'search_concepts',
  description: 'Find files by concept',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, concept: { type: 'string' } },
    required: ['project_name', 'concept'],
  },
  handler: withProject((args, { db }, project) => {
    const files = db.getFilesByConcept(project.id, args.concept as string);
    return files.map(f => `- **${f.path}** (${f.language}, ${f.line_count} lines) — ${f.summary}`).join('\n') || 'No files found.';
  }),
});

const search_by_kind = defineTool({
  name: 'search_by_kind',
  description: 'Search symbols by kind. Common kinds: function, class, interface, type, enum, method, property, variable, constant.',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'number' } },
    required: ['project_name', 'kind'],
  },
  handler: withProject((args, { db }, project) => {
    const kind = args.kind as string;
    const symbols = db.listSymbolsByKind(project.id, kind, (args.limit as number) ?? 20);
    if (symbols.length === 0) {
      return `No symbols found with kind "${kind}". Common kinds: function, class, interface, type, enum, method, property, variable, constant.`;
    }
    return symbols.map(s => `${s.kind} ${s.name} — ${s.file_path}:${s.line ?? '?'} | ${s.signature}`).join('\n');
  }),
});

const grep_code = defineTool({
  name: 'grep_code',
  description: 'Textual search across project files with filters (language/layer/glob). Results capped at max_results (default 20). Use literal=true for exact string matching.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      pattern: { type: 'string' },
      literal: { type: 'boolean' },
      case_sensitive: { type: 'boolean' },
      language: { type: 'string' },
      layer: { type: 'string' },
      glob: { type: 'string' },
      max_results: { type: 'number' },
    },
    required: ['project_name', 'pattern'],
  },
  handler: withProject(async (args, { db }, project) => {
    const pattern = args.pattern as string;
    let literal = args.literal === true;
    const ci = !args.case_sensitive;
    const lang = args.language as string | undefined;
    const layer = args.layer as string | undefined;
    const rawGlob = args.glob as string | undefined;
    // Normalize Windows backslashes — paths in the DB are forward-slash (see
    // scanner normalization), and fast-glob/minimatch expect forward slashes.
    const glob = rawGlob ? rawGlob.replace(/\\/g, '/') : undefined;
    const maxResults = (args.max_results as number) ?? 20;

    let files = db.listFiles(project.id, lang);
    const totalIndexed = files.length;
    if (layer) files = files.filter(f => f.layer === layer);
    if (glob) files = files.filter(f => minimatch(f.path, glob));
    const globMatched = files.length;

    const escaped = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
    let re: RegExp;
    let fallbackNote = '';
    try {
      re = new RegExp(escaped, ci ? 'i' : '');
    } catch {
      // Invalid regex — fall back to literal match instead of blocking the agent.
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ci ? 'i' : '');
      literal = true;
      fallbackNote = `[note: pattern was not valid regex, searched as literal string]\n`;
    }

    // Content-index pre-filter (the IntelliJ word-index): scan bm25-ranked
    // candidate files FIRST and short-circuit when the result cap is already
    // reached — same contract as today (results were capped anyway), ~20-50ms
    // instead of a full read of every indexed file. NOT a complete superset
    // (word index ≠ substring index: literal `Change` hides inside the token
    // `handlechange`), so when the cap isn't reached we FINISH with the
    // remaining files — exactness preserved, the index only buys ordering +
    // early exit.
    const allPaths = files.map(f => f.path);
    let hits: ReturnType<typeof grepInFiles> = [];
    let viaContentIndex = false;
    let scannedAll = false;
    const ftsQuery = process.env.MCP_FTS_CONTENT_GREP !== '0' ? buildContentMatchQuery(pattern, literal) : null;
    if (ftsQuery) {
      try {
        const allowed = new Set(allPaths);
        const candidatePaths = db.searchFileContents(project.id, ftsQuery, 500)
          .map(c => c.path)
          .filter(p => allowed.has(p));
        if (candidatePaths.length > 0) {
          hits = grepInFiles(project.root_path, candidatePaths, re, maxResults);
          if (hits.length >= maxResults) {
            viaContentIndex = true;
            scannedAll = true; // cap reached — nothing more would be returned
          } else {
            const scanned = new Set(candidatePaths);
            hits = hits.concat(grepInFiles(
              project.root_path,
              allPaths.filter(p => !scanned.has(p)),
              re,
              maxResults - hits.length,
            ));
            scannedAll = true;
          }
        }
      } catch {
        // Malformed MATCH / vtab missing (pre-migration DB) — legacy path covers.
      }
    }
    if (!scannedAll) {
      hits = grepInFiles(project.root_path, allPaths, re, maxResults);
    }

    // Disk fallback: when the index can't satisfy the search (empty index,
    // glob filtered everything out, or no hits in indexed set), scan disk
    // directly. Catches files created outside the session or not re-indexed.
    let usedFallback = false;
    let diskScanned = 0;
    if (hits.length === 0) {
      const diskFiles = await scanDiskForGrep(project.root_path, glob);
      diskScanned = diskFiles.length;
      if (diskFiles.length > 0) {
        hits = grepInFiles(project.root_path, diskFiles, re, maxResults);
        usedFallback = hits.length > 0;
      }
    }

    if (hits.length === 0) {
      const diag = ` [indexed: ${totalIndexed}${glob ? `, glob-matched: ${globMatched}` : ''}, disk-scanned: ${diskScanned}]`;
      return fallbackNote + 'No matches.' + diag;
    }
    const results = hits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n');
    const capNote = hits.length >= maxResults ? `\n... [capped at ${maxResults} results]` : '';
    const fallbackTag = usedFallback
      ? '\n[note: results from disk fallback — some files may not be indexed yet, consider re-indexing]'
      : viaContentIndex ? '\n[via content-index]' : '';
    return fallbackNote + results + capNote + fallbackTag;
  }),
});

export const searchTools: McpTool[] = [search, search_global, search_concepts, search_by_kind, grep_code];
