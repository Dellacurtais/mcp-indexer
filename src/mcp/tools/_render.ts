/**
 * Shared Markdown renderers for the outline/symbol tools. The MCP payload is
 * plain text the model reads, so dense Markdown beats verbose JSON — no repeated
 * keys, braces, or quotes.
 */

export interface OutlineSymbol {
  name: string;
  kind: string;
  line?: number | null;
  parent?: string | null;
  signature?: string | null;
}

const CALLABLE = new Set(['function', 'method', 'constructor', 'getter', 'setter']);

/** Filename-convention → role. Returns null when nothing matches (never guesses). */
const ROLE_RULES: Array<[RegExp, string]> = [
  [/\.module\.ts$/i, 'Angular module'],
  [/\.component\.ts$/i, 'Angular component'],
  [/\.directive\.ts$/i, 'Angular directive'],
  [/\.pipe\.ts$/i, 'Angular pipe'],
  [/\.guard\.ts$/i, 'route guard'],
  [/\.resolver\.ts$/i, 'route resolver'],
  [/\.(spec|test)\.[cm]?[tj]sx?$/i, 'test'],
  [/\.controller\.ts$/i, 'controller'],
  [/controller\.cs$/i, 'controller'],
  [/repository\.(cs|ts)$/i, 'repository'],
  [/\.service\.ts$/i, 'service'],
  [/service\.cs$/i, 'service'],
  [/\.dto\.ts$/i, 'DTO'],
  [/dto\.cs$/i, 'DTO'],
  [/\.model\.ts$/i, 'model'],
  [/model\.cs$/i, 'model'],
  [/\.enum\.ts$/i, 'enum'],
  [/\.interface\.ts$/i, 'interface'],
  [/\.config\.[cm]?[tj]s$/i, 'config'],
  [/\.routes?\.ts$/i, 'routes'],
  [/\.store\.ts$/i, 'store'],
];

export function inferFileRole(path: string): string | null {
  const base = (path.replace(/\\/g, '/').split('/').pop() ?? path).toLowerCase();
  for (const [re, role] of ROLE_RULES) if (re.test(base)) return role;
  // React component: PascalCase .tsx/.jsx
  const rawBase = path.replace(/\\/g, '/').split('/').pop() ?? path;
  if (/\.[jt]sx$/.test(rawBase) && /^[A-Z]/.test(rawBase)) return 'React component';
  return null;
}

function symbolLine(s: OutlineSymbol, indent: string): string {
  const call = CALLABLE.has(s.kind) ? '()' : '';
  const loc = s.line != null ? ` (L${s.line})` : '';
  return `${indent}- ${s.kind} ${s.name}${call}${loc}`;
}

/**
 * Render a symbol list as a dense Markdown tree: top-level symbols with their
 * members (parent === this symbol's name) nested one level. Respects a cap.
 */
export function renderSymbolTree(symbols: OutlineSymbol[], max = 200): string {
  const names = new Set(symbols.map((s) => s.name));
  const byLine = (a: OutlineSymbol, b: OutlineSymbol): number =>
    (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);

  const top = symbols.filter((s) => !s.parent || !names.has(s.parent)).sort(byLine);
  const childrenOf = new Map<string, OutlineSymbol[]>();
  for (const s of symbols) {
    if (s.parent && names.has(s.parent)) {
      const arr = childrenOf.get(s.parent) ?? [];
      arr.push(s);
      childrenOf.set(s.parent, arr);
    }
  }

  const lines: string[] = [];
  let count = 0;
  for (const s of top) {
    if (count >= max) break;
    lines.push(symbolLine(s, ''));
    count++;
    for (const c of (childrenOf.get(s.name) ?? []).sort(byLine)) {
      if (count >= max) break;
      lines.push(symbolLine(c, '  '));
      count++;
    }
  }
  return lines.join('\n');
}

/** Comma list with dedupe + cap; returns '' when empty. */
export function joinCapped(items: string[], cap = 20): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const t = it.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= cap) {
      out.push('…');
      break;
    }
  }
  return out.join(', ');
}
