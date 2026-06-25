import { defineTool, type McpTool } from '../tool.js';
import { withProject } from './_helpers.js';

/**
 * One-shot dense "context pack" for a task. Replaces several
 * search → skeleton → read round-trips with a single call: ranked hybrid hits
 * rendered compactly, followed by a symbol skeleton of the top files. Built
 * entirely from existing retrieval primitives (hybrid search + symbols-by-file).
 */
const oneLine = (s: unknown, max: number): string =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const pack_context = defineTool({
  name: 'pack_context',
  description:
    'One-shot dense context pack for a task. Returns ranked hybrid hits as `path:line — kind name — signature` plus a compact symbol skeleton of the top files. Prefer this as the FIRST retrieval call — one call replaces several search/skeleton/read round-trips. Accepts natural language or an identifier.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      query: { type: 'string', description: 'natural language or an identifier' },
      limit: { type: 'number', description: 'max ranked hits (default 12, max 30)' },
    },
    required: ['project_name', 'query'],
  },
  handler: withProject(async (args, { hybridSearch, db }, project) => {
    // Accept `task` as an alias for `query` — the instructions phrase it as "the
    // task", so a model occasionally passes that key.
    const query = String(args.query ?? args.task ?? '').trim();
    if (!query) {
      return 'pack_context needs a non-empty "query" — the task in plain language (e.g. "how does the reranker work") or a symbol name.';
    }
    const limit = Math.min(Math.max(Number(args.limit ?? 12), 1), 30);
    const results = await hybridSearch.search(project.id, project.name, query, {
      mode: 'auto',
      type: 'all',
      limit,
    });
    if (results.length === 0) {
      return `No matches for "${query}". Try fewer/broader keywords, or grep_code for an exact string.`;
    }

    const hitLines: string[] = [];
    const topFiles: string[] = [];
    const pushFile = (fp?: string): void => {
      if (fp && topFiles.length < 3 && !topFiles.includes(fp)) topFiles.push(fp);
    };

    for (const r of results) {
      const d = r.data as unknown as Record<string, unknown>;
      if (r.type === 'file') {
        hitLines.push(
          `${String(d.path)}  — file (${String(d.language)}, ${String(d.line_count)}L)  [${r.score.toFixed(2)}]`,
        );
        pushFile(d.path as string);
      } else {
        const sig = d.signature ? `  ${oneLine(d.signature, 120)}` : '';
        hitLines.push(
          `${String(d.file_path)}:${d.line ?? '?'}  — ${String(d.kind)} ${String(d.name)}${sig}  [${r.score.toFixed(2)}]`,
        );
        pushFile(d.file_path as string);
      }
    }

    const skeletons = topFiles.map((fp) => {
      const syms = db.getSymbolsByFile(project.id, fp);
      const lines = syms
        .slice(0, 40)
        .map(
          (s) =>
            `  ${s.kind} ${s.name}${s.signature ? ': ' + oneLine(s.signature, 100) : ''}  (L${s.line ?? '?'})`,
        );
      return `### ${fp}\n${lines.join('\n') || '  (no symbols)'}`;
    });

    return [
      `# context for: ${query}`,
      '',
      `## ranked hits (${results.length})`,
      ...hitLines,
      '',
      '## top-file skeletons',
      ...skeletons,
    ].join('\n');
  }),
});

export const packTools: McpTool[] = [pack_context];
