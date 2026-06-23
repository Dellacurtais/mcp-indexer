/**
 * Local, zero-cost architecture derivation. Layers are heuristic (path/role),
 * so `get_architecture` is useful even though this build runs no LLM analysis
 * pass. If a future enrichment pass populates `files.layer`, the stored value
 * is preferred over the heuristic.
 */
import type { FileLayer } from '@ctx/shared/types.js';
import { inferFileRole } from './_render.js';

const VALID_LAYERS = new Set<FileLayer>([
  'presentation', 'business', 'data', 'infrastructure', 'config', 'test', 'unknown',
]);

/** Heuristic layer for a path, preferring a real stored layer when present. */
export function classifyLayer(path: string, storedLayer?: string): FileLayer {
  if (storedLayer && storedLayer !== 'unknown' && VALID_LAYERS.has(storedLayer as FileLayer)) {
    return storedLayer as FileLayer;
  }
  const p = path.replace(/\\/g, '/').toLowerCase();
  const base = p.split('/').pop() ?? p;
  const role = inferFileRole(path);

  if (role === 'test' || /\.(spec|test)\.[cm]?[tj]sx?$/.test(base) || /(^|\/)(__tests__|tests?|e2e|spec)\//.test(p)) {
    return 'test';
  }
  if (
    /\.config\.[cm]?[tj]s$/.test(base) ||
    /(^|\/)config\//.test(p) ||
    /^(tsconfig|package|vite\.config|webpack|rollup|esbuild|jest\.config|babel|\.eslintrc|eslint\.config|\.prettierrc)/.test(base)
  ) {
    return 'config';
  }
  if (
    /(^|\/)(infra|infrastructure|deploy|deployment|docker|\.github|ci|cd|k8s|kubernetes|terraform|ops|pipelines?)\//.test(p) ||
    /^(dockerfile|docker-compose)/.test(base)
  ) {
    return 'infrastructure';
  }
  if (
    role === 'repository' || role === 'model' || role === 'DTO' ||
    /\.(repository|model|entity|dto|schema|dao)\.[cm]?[tj]s$/.test(base) ||
    /(^|\/)(migrations?|entities|models?|repositories|repository|dao|store|stores|db|database|persistence)\//.test(p)
  ) {
    return 'data';
  }
  if (
    role === 'Angular component' || role === 'React component' ||
    /\.(component|view|page)\.[cm]?[tj]sx?$/.test(base) ||
    /\.(tsx|jsx|vue|svelte)$/.test(base) ||
    /(^|\/)(components?|views?|pages?|ui|screens?|widgets?|templates?|layouts?)\//.test(p)
  ) {
    return 'presentation';
  }
  if (
    role === 'service' || role === 'controller' ||
    /\.(service|controller|usecase|use-case|handler|resolver|manager|facade)\.[cm]?[tj]s$/.test(base) ||
    /(^|\/)(services?|controllers?|usecases?|use-cases?|handlers?|business|domain|logic)\//.test(p)
  ) {
    return 'business';
  }
  // Recognized source code with no convention → business (the catch-all for app logic).
  if (/\.[cm]?[tj]sx?$/.test(base) || /\.(py|go|rs|java|cs|kt|swift|rb|php|c|h|cpp|hpp|scala|dart)$/.test(base)) {
    return 'business';
  }
  return 'unknown';
}

const LAYER_ORDER: FileLayer[] = [
  'presentation', 'business', 'data', 'infrastructure', 'config', 'test', 'unknown',
];

function isEntryName(path: string): boolean {
  const base = (path.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase();
  return (
    /^(main|cli|server|bootstrap|program)\.[cm]?[tj]sx?$/.test(base) ||
    /^(main|program)\.(py|go|rs|java|cs)$/.test(base) ||
    base === 'app.module.ts' ||
    base === 'program.cs'
  );
}

export interface ArchFile {
  path: string;
  layer: string;
  is_entry_point: number;
}

export interface ArchInput {
  projectName: string;
  files: ArchFile[];
  hubs: Array<{ path: string; dependents: number }>;
  cycles: Array<{ path_a: string; path_b: string }>;
}

/** Dense Markdown architecture map: layers + entry points + hubs + cycles. */
export function renderArchitecture(input: ArchInput): string {
  const { projectName, files, hubs, cycles } = input;

  const counts = new Map<FileLayer, number>();
  for (const f of files) {
    const l = classifyLayer(f.path, f.layer);
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }

  let entryPoints = files.filter((f) => f.is_entry_point).map((f) => f.path);
  if (entryPoints.length === 0) entryPoints = files.filter((f) => isEntryName(f.path)).map((f) => f.path);

  const out: string[] = [`# Architecture · ${projectName}`, '', '## Layers'];
  for (const l of LAYER_ORDER) {
    const n = counts.get(l);
    if (n) out.push(`- ${l === 'unknown' ? 'other' : l}: ${n} files`);
  }
  out.push('(heuristic — path/role based; run `code-context enrich` for LLM-verified layers)');

  if (entryPoints.length) {
    out.push('', '## Entry points', ...entryPoints.slice(0, 12).map((p) => `- ${p}`));
  }
  if (hubs.length) {
    out.push('', '## Hubs (most depended-on)', ...hubs.map((h) => `- ${h.path} ← ${h.dependents} dependents`));
  }
  if (cycles.length) {
    out.push(
      '',
      `## Dependency cycles (${cycles.length})`,
      ...cycles.slice(0, 10).map((c) => `- ${c.path_a} ↔ ${c.path_b}`),
    );
  }
  return out.join('\n');
}
