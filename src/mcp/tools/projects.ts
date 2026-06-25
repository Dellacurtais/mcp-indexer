import { defineTool, type McpTool } from '../tool.js';
import { truncateToTokens } from '../utils.js';
import { buildRepoMap } from '@ctx/services/services/repo-map.js';
import { withProject } from './_helpers.js';
import { classifyLayer, renderArchitecture } from './_architecture.js';

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
    const s = db.getStats(project.id);
    const langs = Object.entries(s.languages)
      .sort((a, b) => b[1] - a[1])
      .map(([l, c]) => `${l}(${c})`)
      .join(' ');
    return [
      `# ${project.name}`,
      `files: ${s.file_count} · symbols: ${s.symbol_count} · lines: ${s.total_lines}`,
      langs ? `langs: ${langs}` : '',
    ]
      .filter(Boolean)
      .join('\n');
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
    // Layers from the same heuristic get_architecture/get_project_pulse use, so all
    // three orientation tools agree (the stored files.layer column is mostly
    // 'unknown' until the optional enrichment pass runs).
    const layerCount = new Map<string, number>();
    for (const f of files) {
      const l = classifyLayer(f.path, f.layer);
      if (l !== 'unknown') layerCount.set(l, (layerCount.get(l) ?? 0) + 1);
    }
    const layerEntries = [...layerCount.entries()].sort((a, b) => b[1] - a[1]);
    const compact = args.compact === true;

    if (compact) {
      const maxFiles = (args.max_files as number) ?? 50;
      const langs = Object.entries(stats.languages).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}(${c})`).join(' ');
      const layers = layerEntries.map(([l, c]) => `${l}(${c})`).join(' ');
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
      `Files: ${stats.file_count} | Symbols: ${stats.symbol_count} | Lines: ${stats.total_lines.toLocaleString('en-US')} | Runs: ${stats.run_count}`,
      `Last Indexed: ${stats.last_indexed ?? 'Never'}`,
      '',
      '## Languages',
      Object.entries(stats.languages).sort((a, b) => b[1] - a[1]).map(([l, c]) => `- ${l}: ${c} files`).join('\n'),
    ];

    if (layerEntries.length > 0) {
      sections.push('', '## Architecture Layers (heuristic)', layerEntries.map(([l, c]) => `- ${l}: ${c} files`).join('\n'));
    }
    if (concepts.length > 0) {
      sections.push('', '## Key Concepts', concepts.map(c => `- ${c.concept} (${c.count} files)`).join('\n'));
    }
    const maxFiles = (args.max_files as number) ?? 80;
    const fileList = files.slice(0, maxFiles).map(f => `- ${f.path} (${f.language}, ${f.line_count} lines)`).join('\n')
      + (files.length > maxFiles ? `\n  ... +${files.length - maxFiles} more — use compact=true or max_files` : '');
    sections.push('', `## Files (${files.length})`, fileList);
    return truncateToTokens(sections.join('\n'), args.max_tokens as number | undefined);
  }),
});

const get_project_pulse = defineTool({
  name: 'get_project_pulse',
  description: 'Ultra-compact Markdown project overview (~250 tokens). Use this as the FIRST contextualization tool.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
    },
    required: ['project_name'],
  },
  handler: withProject((args, { db }, project) => {
    const stats = db.getStats(project.id);
    const files = db.listFiles(project.id);
    const conceptCount = new Map<string, number>();
    const layerCount = new Map<string, number>();
    const entryPoints: string[] = [];
    for (const f of files) {
      if (f.is_entry_point) entryPoints.push(f.path);
      const layer = classifyLayer(f.path, f.layer);
      if (layer !== 'unknown') layerCount.set(layer, (layerCount.get(layer) ?? 0) + 1);
      try {
        const cs = JSON.parse(f.concepts || '[]') as string[];
        for (const c of cs) conceptCount.set(c, (conceptCount.get(c) ?? 0) + 1);
      } catch { /* ignore */ }
    }
    const topConcepts = [...conceptCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);
    const langs = Object.entries(stats.languages).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, n]) => `${l}(${n})`).join(' ');
    const layers = [...layerCount.entries()].sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}(${c})`).join(' ');
    const snaps = db.listSnapshots(project.id);
    const costs = db.getCostSummary(project.id);
    const avgCost = stats.file_count > 0 ? costs.total_cost_usd / stats.file_count : 0;
    const cov = db.getEmbeddingCoverage(project.id);
    const filePct = cov.files_total > 0 ? Math.round((cov.files_embedded / cov.files_total) * 100) : 0;
    const symPct = cov.symbols_total > 0 ? Math.round((cov.symbols_embedded / cov.symbols_total) * 100) : 0;
    const bodyPct = cov.symbol_bodies_total > 0 ? Math.round((cov.symbol_bodies_embedded / cov.symbol_bodies_total) * 100) : 0;

    const fmt = (n: number): string => n.toLocaleString('en-US');
    const covLine = cov.files_total > 0
      ? `Vector coverage: files ${filePct}% · symbols ${symPct}% · bodies ${bodyPct}%`
      : 'Vector coverage: none (FTS only)';
    const costLine = costs.total_cost_usd > 0
      ? `Cost: $${costs.total_cost_usd.toFixed(4)} (llm $${costs.llm_analysis_cost_usd.toFixed(4)} + emb $${costs.embedding_cost_usd.toFixed(4)}) · avg/file $${avgCost.toFixed(5)}`
      : '';
    const body = [
      langs ? `Languages: ${langs}` : '',
      layers ? `Layers: ${layers}` : '',
      topConcepts.length ? `Concepts: ${topConcepts.join(', ')}` : '',
      entryPoints.length ? `Entry points: ${entryPoints.slice(0, 5).join(', ')}` : '',
      snaps.length ? `Snapshots: ${snaps.length}` : '',
      covLine,
      costLine,
    ].filter(Boolean);
    return [
      `# ${project.name}`,
      `${fmt(stats.file_count)} files · ${fmt(stats.symbol_count)} symbols · ${fmt(stats.total_lines)} lines · indexed ${stats.last_indexed ?? 'never'}`,
      '',
      ...body,
    ].join('\n');
  }),
});

const get_architecture = defineTool({
  name: 'get_architecture',
  description: 'Markdown architecture map: files grouped by layer + entry points + dependency hubs (most depended-on) + circular dependencies. Use after get_project_pulse to orient in an unfamiliar codebase.',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' } },
    required: ['project_name'],
  },
  handler: withProject((args, { db }, project) => {
    return renderArchitecture({
      projectName: project.name,
      summary: project.summary,
      files: db.listFiles(project.id),
      hubs: db.getTopHubs(project.id, 12),
      cycles: db.getCircularDeps(project.id),
    });
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
