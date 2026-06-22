import { defineTool, type McpTool } from '../tool.js';
import { truncateToTokens } from '../utils.js';
import { buildRepoMap } from '@ctx/services/services/repo-map.js';
import { withProject } from './_helpers.js';

const list_projects = defineTool({
  name: 'list_projects',
  description: 'List all indexed projects',
  inputSchema: { type: 'object', properties: {} },
  handler: (_args, { db }) => {
    const projects = db.listProjects();
    return projects
      .map(p => `${p.name} (${p.root_path}) — ${p.file_count} files, last indexed: ${p.last_indexed ?? 'never'}`)
      .join('\n') || 'No projects registered.';
  },
});

const get_project_stats = defineTool({
  name: 'get_project_stats',
  description: 'Get project statistics',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' } },
    required: ['project_name'],
  },
  handler: withProject((args, { db }, project) => {
    return JSON.stringify(db.getStats(project.id), null, 2);
  }),
});

const get_project_overview = defineTool({
  name: 'get_project_overview',
  description: 'Get project overview with file list and concepts. Use compact=true for dense output. In compact mode, file list is capped by max_files (default 50).',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      compact: { type: 'boolean' },
      max_tokens: { type: 'number' },
      max_files: { type: 'number', description: 'Max files listed in compact mode (default 50)' },
    },
    required: ['project_name'],
  },
  handler: withProject((args, { db }, project) => {
    const stats = db.getStats(project.id);
    const concepts = db.listConcepts(project.id);
    const files = db.listFiles(project.id);
    const archOverview = db.getArchitectureOverview(project.id);
    const compact = args.compact === true;

    if (compact) {
      const maxFiles = (args.max_files as number) ?? 50;
      const langs = Object.entries(stats.languages).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}(${c})`).join(' ');
      const layers = archOverview.map(l => `${l.layer}(${l.count})`).join(' ');
      const conc = concepts.slice(0, 8).map(c => c.concept).join(', ');
      const shownFiles = files.slice(0, maxFiles);
      const fileTrunc = files.length > maxFiles
        ? `\n  ... [${files.length - maxFiles} more files omitted — use max_files to expand]`
        : '';
      const out = `${project.name} | ${stats.file_count}f ${stats.symbol_count}s ${stats.total_lines}L\nlangs: ${langs}\nlayers: ${layers}\nconcepts: ${conc}\nfiles:\n${shownFiles.map(f => `  ${f.path} (${f.language},${f.line_count}L)`).join('\n')}${fileTrunc}`;
      return truncateToTokens(out, args.max_tokens as number | undefined);
    }

    const sections = [
      `# ${project.name}`,
      `Path: ${project.root_path}`,
      `Files: ${stats.file_count} | Symbols: ${stats.symbol_count} | Lines: ${stats.total_lines.toLocaleString()} | Runs: ${stats.run_count}`,
      `Last Indexed: ${stats.last_indexed ?? 'Never'}`,
      '',
      '## Languages',
      Object.entries(stats.languages).sort((a, b) => b[1] - a[1]).map(([l, c]) => `- ${l}: ${c} files`).join('\n'),
    ];

    if (archOverview.length > 0) {
      sections.push('', '## Architecture Layers', archOverview.map(l => `- ${l.layer}: ${l.count} files`).join('\n'));
    }
    if (concepts.length > 0) {
      sections.push('', '## Key Concepts', concepts.map(c => `- ${c.concept} (${c.count} files)`).join('\n'));
    }
    sections.push('', '## Files', files.map(f => `- ${f.path} (${f.language}, ${f.line_count} lines, ${f.complexity})`).join('\n'));
    return truncateToTokens(sections.join('\n'), args.max_tokens as number | undefined);
  }),
});

const get_project_pulse = defineTool({
  name: 'get_project_pulse',
  description: 'Ultra-compact project overview (~250 tokens). Use this as the FIRST contextualization tool. Pass format="json" for a structured response.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      format: { type: 'string', enum: ['text', 'json'], description: 'Response format (default text)' },
    },
    required: ['project_name'],
  },
  handler: withProject((args, { db }, project) => {
    const stats = db.getStats(project.id);
    const arch = db.getArchitectureOverview(project.id);
    const files = db.listFiles(project.id);
    const conceptCount = new Map<string, number>();
    const entryPoints: string[] = [];
    for (const f of files) {
      if (f.is_entry_point) entryPoints.push(f.path);
      try {
        const cs = JSON.parse(f.concepts || '[]') as string[];
        for (const c of cs) conceptCount.set(c, (conceptCount.get(c) ?? 0) + 1);
      } catch { /* ignore */ }
    }
    const topConcepts = [...conceptCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);
    const langs = Object.entries(stats.languages).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, n]) => `${l}(${n})`).join(' ');
    const layers = arch.map(a => `${a.layer}(${a.count})`).join(' ');
    const snaps = db.listSnapshots(project.id);
    const costs = db.getCostSummary(project.id);
    const avgCost = stats.file_count > 0 ? costs.total_cost_usd / stats.file_count : 0;
    const cov = db.getEmbeddingCoverage(project.id);
    const filePct = cov.files_total > 0 ? Math.round((cov.files_embedded / cov.files_total) * 100) : 0;
    const symPct = cov.symbols_total > 0 ? Math.round((cov.symbols_embedded / cov.symbols_total) * 100) : 0;
    const bodyPct = cov.symbol_bodies_total > 0 ? Math.round((cov.symbol_bodies_embedded / cov.symbol_bodies_total) * 100) : 0;

    if (args.format === 'json') {
      return JSON.stringify({
        project: project.name,
        file_count: stats.file_count,
        symbol_count: stats.symbol_count,
        total_lines: stats.total_lines,
        last_indexed: stats.last_indexed ?? null,
        languages: stats.languages,
        layers: arch,
        top_concepts: topConcepts,
        entry_points: entryPoints.slice(0, 5),
        snapshots_count: snaps.length,
        vector_coverage: {
          files_pct: filePct,
          symbols_pct: symPct,
          bodies_pct: bodyPct,
        },
        cost: {
          total_usd: costs.total_cost_usd,
          llm_analysis_usd: costs.llm_analysis_cost_usd,
          embedding_usd: costs.embedding_cost_usd,
          per_file_avg_usd: avgCost,
        },
      });
    }

    const costLine = costs.total_cost_usd > 0
      ? `cost: $${costs.total_cost_usd.toFixed(4)} (llm $${costs.llm_analysis_cost_usd.toFixed(4)} + emb $${costs.embedding_cost_usd.toFixed(4)}) | avg/file: $${avgCost.toFixed(5)}`
      : '';
    const covLine = cov.files_total > 0
      ? `vector coverage: files ${filePct}% | symbols ${symPct}% | bodies ${bodyPct}%`
      : 'vector coverage: none (search will use FTS only)';
    const lines = [
      `${project.name} | ${stats.file_count} files, ${stats.symbol_count} symbols, ${stats.total_lines}L | indexed: ${stats.last_indexed ?? 'never'}`,
      `langs: ${langs}`,
      `layers: ${layers}`,
      `top concepts: ${topConcepts.join(', ')}`,
      entryPoints.length ? `entry points: ${entryPoints.slice(0, 5).join(', ')}` : '',
      `snapshots: ${snaps.length}`,
      covLine,
      costLine,
    ].filter(Boolean);
    return lines.join('\n');
  }),
});

const get_architecture = defineTool({
  name: 'get_architecture',
  description: 'Get project architecture overview (files grouped by layer)',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' } },
    required: ['project_name'],
  },
  handler: withProject((args, { db }, project) => {
    const overview = db.getArchitectureOverview(project.id);
    return overview.map(l => `${l.layer}: ${l.count} files`).join('\n') || 'No architecture data.';
  }),
});

const get_repo_map = defineTool({
  name: 'get_repo_map',
  description: 'Structural map of the repository (~2000 tokens). Shows key files weighted by importance (entry points, hubs, high-complexity) with their top symbols. Use after get_project_pulse for a mental model of the codebase architecture. Based on dependency graph analysis (PageRank-style scoring).',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      max_tokens: { type: 'number', description: 'Token budget (default 2000)' },
    },
    required: ['project_name'],
  },
  handler: withProject((args, { db }, project) => {
    const maxTokens = (args.max_tokens as number) ?? 2000;
    return buildRepoMap(db, project.id, maxTokens);
  }),
});

export const projectTools: McpTool[] = [
  list_projects,
  get_project_stats,
  get_project_overview,
  get_project_pulse,
  get_repo_map,
  get_architecture,
];
