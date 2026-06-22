/**
 * Read-only terminal commands over an existing index: `status`, `search`,
 * `projects`. Results go to stdout (pipeable); progress/errors to stderr.
 */
import { disposeIndexerProcessResources } from '@ctx/indexer/bootstrap/dispose.js';
import { languageIdForPath } from '@ctx/shared/utils/language-id.js';
import { resolveRoot, openProject, openDb, log } from './shared.js';

const toLangSet = (v: string | undefined): Set<string> =>
  new Set((v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

const out = (s: string): void => {
  process.stdout.write(s.endsWith('\n') ? s : s + '\n');
};
const pct = (e: number, t: number): number => (t > 0 ? Math.round((e / t) * 100) : 0);

/** `status [root]` — index coverage for a project (defaults to the current dir). */
export function runStatus(rootArg: string | undefined): void {
  const root = resolveRoot(rootArg ?? process.cwd());
  const { db } = openDb();
  try {
    const project = db.getProjectByPath(root);
    if (!project) {
      out(`not indexed: ${root}\n  run:  code-context index "${root}"`);
      return;
    }
    const stats = db.getStats(project.id);
    const cov = db.getEmbeddingCoverage(project.id);
    const stale = db.countSemanticStale(project.id);
    const langs = Object.entries(stats.languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([l, n]) => `${l}(${n})`)
      .join(' ');
    out(`${project.name}  (${root})`);
    out(`  files: ${stats.file_count}   symbols: ${stats.symbol_count}   lines: ${stats.total_lines}`);
    out(`  langs: ${langs || '(none)'}`);
    out(
      `  vector coverage: files ${pct(cov.files_embedded, cov.files_total)}%  ` +
        `symbols ${pct(cov.symbols_embedded, cov.symbols_total)}%  ` +
        `bodies ${pct(cov.symbol_bodies_embedded, cov.symbol_bodies_total)}%`,
    );
    out(`  semantic-stale files: ${stale}   last indexed: ${project.last_indexed ?? 'never'}`);
  } finally {
    db.close();
  }
}

/** `projects` — list every indexed project. */
export function runProjects(): void {
  const { db } = openDb();
  try {
    const projects = db.listProjects();
    if (projects.length === 0) {
      out('No indexed projects.');
      return;
    }
    for (const p of projects) {
      out(`${p.name}`);
      out(`  ${p.root_path}`);
      out(`  ${p.file_count} files, ${p.symbol_count} symbols — indexed: ${p.last_indexed ?? 'never'}`);
    }
  } finally {
    db.close();
  }
}

export interface SearchOpts {
  mode?: string;
  type?: string;
  limit?: string;
  lang?: string;
  excludeLang?: string;
}

/** `search <query> [root]` — query the index and print ranked hits. */
export async function runSearch(
  query: string,
  rootArg: string | undefined,
  opts: SearchOpts,
): Promise<void> {
  const root = resolveRoot(rootArg ?? process.cwd());
  const opened = openProject(root, {});
  try {
    if (db_isEmpty(opened)) {
      out(`not indexed: ${root}\n  run:  code-context index "${root}"`);
      return;
    }
    const limit = opts.limit ? Math.max(1, Number(opts.limit)) : 15;
    const include = toLangSet(opts.lang);
    const exclude = toLangSet(opts.excludeLang);
    const hasLangFilter = include.size > 0 || exclude.size > 0;
    const raw = await opened.ctx.hybridSearch.search(
      opened.project.id,
      opened.project.name,
      query,
      {
        mode: (opts.mode as 'auto' | 'fts' | 'vector' | 'hybrid') ?? 'auto',
        type: (opts.type as 'files' | 'symbols' | 'all') ?? 'all',
        limit: hasLangFilter ? Math.min(limit * 5, 100) : limit,
      },
    );
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
      out('No results.');
      return;
    }
    for (const r of results) {
      const d = r.data as unknown as Record<string, unknown>;
      if (r.type === 'file') {
        out(`[file]   ${String(d.path)}  (${String(d.language)})  [${r.score.toFixed(2)}]`);
      } else {
        out(
          `[symbol] ${String(d.file_path)}:${d.line ?? '?'}  ${String(d.kind)} ${String(d.name)}  [${r.score.toFixed(2)}]`,
        );
      }
    }
  } catch (e) {
    log(`search error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    try {
      await disposeIndexerProcessResources();
    } catch {
      /* ignore */
    }
    opened.db.close();
  }
}

function db_isEmpty(opened: ReturnType<typeof openProject>): boolean {
  return (opened.db.getStats(opened.project.id).file_count ?? 0) === 0;
}
