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

/** Recognized source-code extensions → the "everything else is business" catch-all. */
const SRC_EXT = /\.(c|cc|cpp|cxx|h|hpp|cs|java|kt|kts|swift|rb|php|py|go|rs|scala|dart|ts|tsx|js|jsx|mjs|cjs|m|mm|ex|exs|clj)$/;

/**
 * Heuristic layer for a path, preferring a real stored layer when present.
 * Polyglot: convention suffixes are matched regardless of extension (PascalCase
 * `UserController.cs`, snake_case `user_service.py`, bare `models.py`), plus
 * language-agnostic directory and framework-file rules. Rule order matters:
 * test → config → infra → data → presentation → business → source fallback.
 */
export function classifyLayer(path: string, storedLayer?: string): FileLayer {
  if (storedLayer && storedLayer !== 'unknown' && VALID_LAYERS.has(storedLayer as FileLayer)) {
    return storedLayer as FileLayer;
  }
  const p = path.replace(/\\/g, '/').toLowerCase();
  const base = p.split('/').pop() ?? p;
  const role = inferFileRole(path);

  // ── test ──
  if (
    role === 'test' ||
    /\.(spec|test)\.[cm]?[tj]sx?$/.test(base) ||
    /(^|\/)(__tests__|tests?|e2e|specs?)\//.test(p) ||
    /\.tests?\//.test(p) ||                                 // .NET MyApp.Tests/
    /(tests?|spec)\.(cs|java|kt|php|rb|go)$/.test(base) ||  // UserTests.cs, FooSpec.java
    /^test_.*\.py$/.test(base) || /_test\.(py|go)$/.test(base)
  ) {
    return 'test';
  }

  // ── config ──
  if (
    /\.config\.[cm]?[tj]s$/.test(base) ||
    /(^|\/)config\//.test(p) ||
    /^(tsconfig|jsconfig|package|vite\.config|webpack|rollup|esbuild|jest\.config|vitest\.config|babel|\.eslintrc|eslint\.config|\.prettierrc|\.editorconfig)/.test(base) ||
    /^appsettings(\.|$)/.test(base) || base === 'web.config' || base === 'app.config' ||
    /\.(csproj|sln|props|targets|fsproj|vbproj)$/.test(base) ||
    /^application\.(ya?ml|properties)$/.test(base) ||
    base === 'settings.py' || base === 'pyproject.toml' || base === 'setup.py' || base === 'setup.cfg' ||
    /^requirements.*\.txt$/.test(base) || base === 'pipfile' ||
    base === 'go.mod' || base === 'go.sum' || base === 'composer.json' || base === 'composer.lock' ||
    base === 'pom.xml' || /^build\.gradle(\.kts)?$/.test(base) || base === 'settings.gradle' ||
    base === 'gemfile' || base === 'cargo.toml' || /^\.env($|\.)/.test(base)
  ) {
    return 'config';
  }

  // ── infrastructure ──
  if (
    /(^|\/)(infra|infrastructure|deploy|deployment|docker|\.github|ci|cd|k8s|kubernetes|terraform|ops|pipelines?|helm|charts?|ansible)\//.test(p) ||
    /^dockerfile/.test(base) || /^docker-compose/.test(base) ||
    /\.(tf|tfvars|bicep)$/.test(base) ||
    base === 'serverless.yml' || base === 'serverless.yaml' || base === 'wrangler.toml' || base === 'nginx.conf'
  ) {
    return 'infrastructure';
  }

  // ── data ──
  if (
    role === 'repository' || role === 'model' || role === 'DTO' ||
    /(repository|entity|dao|dbcontext)\.(cs|java|kt|php|rb|go|py|ts|js)$/.test(base) || // UserRepository.cs, AppDbContext.cs (NOT bare context.ts — usually DI/React, not DB)
    /[._-](repository|model|entity|dto|schema|dao|serializer)\.[cm]?[tj]sx?$/.test(base) ||
    /^(models?|schemas?|serializers?|entities)\.py$/.test(base) ||                              // models.py, serializers.py
    /\.sql$/.test(base) ||
    /(^|\/)(migrations?|entities|models?|repositories|repository|dao|store|stores|db|database|persistence|schemas?)\//.test(p)
  ) {
    return 'data';
  }

  // ── presentation ──
  if (
    role === 'Angular component' || role === 'React component' ||
    /\.(component|view|page)\.[cm]?[tj]sx?$/.test(base) ||
    /\.(tsx|jsx|vue|svelte|astro|cshtml|razor|erb)$/.test(base) ||
    /\.blade\.php$/.test(base) ||
    base === 'views.py' ||
    /(^|\/)(components?|views?|pages?|ui|screens?|widgets?|templates?|layouts?|wwwroot|public|partials?)\//.test(p)
  ) {
    return 'presentation';
  }

  // ── business ──
  if (
    role === 'service' || role === 'controller' ||
    /(controller|service|usecase|use-case|handler|resolver|manager|facade|interactor)\.(cs|java|kt|php|rb|go|py|ts|js)$/.test(base) ||
    /[._-](service|controller|usecase|use-case|handler|resolver|manager|facade|middleware|validator|mapper)\.[cm]?[tj]sx?$/.test(base) ||
    /\.(service|controller|usecase|use-case|handler|resolver|manager|facade)\.[cm]?[tj]s$/.test(base) ||
    /(^|\/)(services?|controllers?|usecases?|use-cases?|handlers?|business|domain|logic|application)\//.test(p)
  ) {
    return 'business';
  }

  // Recognized source code with no convention → business (the catch-all for app logic).
  if (SRC_EXT.test(base)) return 'business';
  return 'unknown';
}

const LAYER_ORDER: FileLayer[] = [
  'presentation', 'business', 'data', 'infrastructure', 'config', 'test', 'unknown',
];

function isEntryName(path: string): boolean {
  const p = path.replace(/\\/g, '/').toLowerCase();
  const base = p.split('/').pop() ?? '';
  return (
    // `bootstrap` removed: */schema/bootstrap.ts is a migration util, not an entry,
    // and was the only false positive on this repo.
    /^(main|cli|server|program)\.[cm]?[tj]sx?$/.test(base) ||
    /(^|\/)(cli|bin)\/index\.[cm]?[tj]sx?$/.test(p) ||        // the real CLI bin entry (not every index.ts)
    /^(main|program)\.(py|go|rs|java|cs|kt)$/.test(base) ||
    base === 'app.module.ts' ||                              // Angular root
    base === 'program.cs' || base === 'startup.cs' || base === 'global.asax' ||  // .NET
    base === 'manage.py' || base === '__main__.py' || base === 'wsgi.py' || base === 'asgi.py' ||  // Python
    /application\.(java|kt)$/.test(base) ||                  // Spring *Application.java
    /(^|\/)cmd\/[^/]+\/main\.go$/.test(p) ||                 // Go cmd/<x>/main.go
    base === 'index.php' || base === 'artisan'               // PHP / Laravel
  );
}

export interface ArchFile {
  path: string;
  layer: string;
  is_entry_point: number;
}

export interface ArchInput {
  projectName: string;
  summary?: string | null;
  files: ArchFile[];
  hubs: Array<{ path: string; dependents: number }>;
  cycles: Array<{ path_a: string; path_b: string }>;
}

/** Dense Markdown architecture map: layers + entry points + hubs + cycles. */
export function renderArchitecture(input: ArchInput): string {
  const { projectName, summary, files, hubs, cycles } = input;

  const counts = new Map<FileLayer, number>();
  for (const f of files) {
    const l = classifyLayer(f.path, f.layer);
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }

  let entryPoints = files.filter((f) => f.is_entry_point).map((f) => f.path);
  if (entryPoints.length === 0) entryPoints = files.filter((f) => isEntryName(f.path)).map((f) => f.path);

  const out: string[] = [`# Architecture · ${projectName}`];
  if (summary) out.push('', summary);
  out.push('', '## Layers');
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
