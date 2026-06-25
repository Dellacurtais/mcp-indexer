import { join } from 'node:path';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { defineTool, type McpTool } from '../tool.js';
import {
  readFileSlice,
  extractSkeletonFromFile,
  extractSymbolBodyFromContent,
  findSymbolDeclLineFromContent,
  findEnclosingDeclLine,
} from '@ctx/services/services/code-reader.js';
import { treeSitterSymbols } from '@ctx/indexer/indexer/incremental.js';
import { normalizeFilePath, withProject, formatOutput } from './_helpers.js';
import { inferFileRole, renderSymbolTree, joinCapped, type OutlineSymbol } from './_render.js';

/**
 * Tree-sitter-driven skeleton fallback. Used when the symbol DB has no row
 * for the file (project never indexed, or freshly created file). Reads
 * directly from disk under the project root and returns a skeleton-shaped
 * payload that callers can render in either text or JSON form.
 *
 * Returns null when the file isn't on disk or tree-sitter can't parse it.
 */
async function diskSkeletonFallback(
  projectRoot: string,
  relPath: string,
): Promise<{
  symbols: Array<{ line: number; end_line?: number; kind: string; name: string; signature: string; parent: string | null }>;
  lineCount: number;
  bytes: number;
} | null> {
  const abs = join(projectRoot, relPath);
  if (!existsSync(abs)) return null;
  let content: string;
  try {
    content = readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
  let stat: { size: number };
  try { stat = statSync(abs); } catch { stat = { size: content.length }; }
  const lineCount = content.split('\n').length;
  const ts = await treeSitterSymbols(relPath, content);
  if (ts) {
    return {
      symbols: ts.symbols.map((s) => ({
        line: s.line,
        end_line: s.end_line,
        kind: s.kind,
        name: s.name,
        signature: s.signature,
        parent: s.parent,
      })),
      lineCount,
      bytes: stat.size,
    };
  }
  // Last-resort regex skeleton — covers languages without a tree-sitter grammar.
  const regex = extractSkeletonFromFile(abs);
  if (regex.length === 0) return null;
  return {
    symbols: regex.map((e) => ({
      line: e.line,
      end_line: undefined,
      kind: e.kind,
      name: e.name,
      signature: e.signature,
      parent: null,
    })),
    lineCount,
    bytes: stat.size,
  };
}

const get_file_structure = defineTool({
  name: 'get_file_structure',
  description: 'Get file details and symbols. Hard-capped to max_symbols (default 50) to protect context limits. Use get_file_skeleton if you just need a broad outline.',
  inputSchema: {
    type: 'object',
    properties: {
        project_name: { type: 'string' },
        file_path: { type: 'string' },
        max_symbols: { type: 'number', description: 'Max symbols to list. Default 50.' },
        force_reread: {
          type: 'boolean',
          description: 'Bypass the duplicate-result marker. Set true if you believe the file changed since a previous call. Default false.',
        },
    },
    required: ['project_name', 'file_path'],
  },
  handler: withProject(async (args, { db }, project) => {
    const filePath = normalizeFilePath(args.file_path as string, project.root_path);
    const file = db.getFile(project.id, filePath);
    if (!file) {
      // Tree-sitter fallback (same logic as get_file_skeleton). Skips
      // dependency / dependents data since those are DB-only — the agent
      // gets a structural outline instead of a full file_structure record.
      const fallback = await diskSkeletonFallback(project.root_path, filePath);
      if (!fallback) {
        throw new Error(
          `File "${filePath}" not found in index nor on disk (or its language is unsupported). ` +
          `Use list_directory or search to find the correct path. Do not retry with the same file_path.`,
        );
      }
      const maxSymbolsX = (args.max_symbols as number) ?? 50;
      const shownX = fallback.symbols.slice(0, maxSymbolsX);
      const sectionsX: string[] = [
        `# ${filePath}`,
        `Lines: ${fallback.lineCount} | Source: tree-sitter fallback (project not indexed)`,
        '',
        `## Symbols (${fallback.symbols.length})`,
      ];
      if (fallback.symbols.length > maxSymbolsX) {
        sectionsX.push(`[truncated: showing ${shownX.length}/${fallback.symbols.length} symbols — pass max_symbols to broaden, or use get_file_skeleton.]`);
      }
      for (const s of shownX) {
        const parts = [`### ${s.kind} \`${s.name}\``];
        if (s.signature) parts.push(`Signature: \`${s.signature}\``);
        if (s.parent) parts.push(`Parent: ${s.parent}`);
        if (s.line) parts.push(`Line: ${s.line}`);
        sectionsX.push(parts.join('\n'));
      }
      return sectionsX.join('\n');
    }
    const symbols = db.getSymbolsByFile(project.id, filePath);
    const concepts = JSON.parse(file.concepts) as string[];
    const deps = db.getDependencies(file.id, project.id);
    const dependents = db.getDependents(project.id, file.id);

    const role = inferFileRole(file.path);
    const metaBits = [
      file.complexity && file.complexity !== 'unknown' ? `complexity=${file.complexity}` : '',
      file.layer && file.layer !== 'unknown' ? `layer=${file.layer}` : '',
      file.is_entry_point ? 'entry-point' : '',
      file.is_test ? 'test' : '',
    ].filter(Boolean);
    const sections = [
      `# ${file.path} · ${file.line_count} lines · ${file.language}`,
      role ? `Role: ${role}` : '',
      metaBits.length ? metaBits.join(' | ') : '',
    ].filter(Boolean);
    // Drop the empty Summary/Concepts blocks (no LLM enrichment in this build).
    if (file.summary) sections.push('', '## Summary', file.summary);
    if (concepts.length) sections.push('', `Concepts: ${concepts.join(', ')}`);

    if (deps.length > 0) {
      sections.push('', '## Dependencies (imports)', deps.map(d => `- [${d.dep_type}] ${d.import_path}${d.target_file_path ? ` → ${d.target_file_path}` : ''}`).join('\n'));
    }
    if (dependents.length > 0) {
      sections.push('', '## Dependents (imported by)', dependents.map(d => `- ${d.source_file_path} (via ${d.import_path})`).join('\n'));
    }

    if (symbols.length > 0) {
      const maxSymbols = (args.max_symbols as number) ?? 50;
      const shownSymbols = symbols.slice(0, maxSymbols);

      sections.push('', `## Symbols (${symbols.length})`);
      if (symbols.length > maxSymbols) {
          sections.push(`[truncated: showing ${maxSymbols}/${symbols.length} symbols — file has too many symbols. Use get_file_skeleton or grep_code for deeper exploration without context bloat.]`);
      }

      for (const s of shownSymbols) {
        const parts = [`### ${s.kind} \`${s.name}\``];
        if (s.signature) parts.push(`Signature: \`${s.signature}\``);
        if (s.comment) parts.push(s.comment);
        if (s.parent) parts.push(`Parent: ${s.parent}`);
        if (s.line) parts.push(`Line: ${s.line}`);
        const tags = JSON.parse(s.tags) as string[];
        if (tags.length > 0) parts.push(`Tags: ${tags.join(', ')}`);
        sections.push(parts.join('\n'));
      }
    }
    return sections.join('\n');
  }),
});

const get_file_skeleton = defineTool({
  name: 'get_file_skeleton',
  description: 'Markdown digest of a file: header + role + imports + exports + a nested symbol outline. Token-cheap; prefer this over reading whole files. Capped by max_symbols (default 100).',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      file_path: { type: 'string' },
      kind: { type: 'string', description: 'Filter by symbol kind' },
      filter: { type: 'string', description: 'Regex on symbol name' },
      max_symbols: { type: 'number', description: 'Max symbols listed (default 100)' },
    },
    required: ['project_name', 'file_path'],
  },
  handler: withProject(async (args, { db }, project) => {
    const filePath = normalizeFilePath(args.file_path as string, project.root_path);
    const kindFilter = args.kind as string | undefined;
    const nameFilter = args.filter as string | undefined;
    const maxSymbols = (args.max_symbols as number) ?? 100;
    const applyFilters = <T extends { kind: string; name: string }>(syms: T[]): T[] => {
      let out = syms;
      if (kindFilter) out = out.filter((s) => s.kind === kindFilter);
      if (nameFilter) {
        try { const re = new RegExp(nameFilter); out = out.filter((s) => re.test(s.name)); } catch { /* ignore */ }
      }
      return out;
    };

    const file = db.getFile(project.id, filePath);
    if (!file) {
      // Tree-sitter fallback: parse off disk so the agent gets a digest even
      // when the project isn't indexed yet.
      const fallback = await diskSkeletonFallback(project.root_path, filePath);
      if (!fallback) {
        throw new Error(
          `File "${filePath}" not found in index nor on disk (or its language is unsupported). ` +
          `Use list_directory or search to find the correct path. Do not retry with the same file_path.`,
        );
      }
      const syms = applyFilters(fallback.symbols);
      const ext = filePath.split('.').pop() ?? '';
      const lines = [`# ${filePath} · ${fallback.lineCount} lines · ${ext}  (not indexed — tree-sitter)`];
      const role = inferFileRole(filePath);
      if (role) lines.push(`Role: ${role}`);
      lines.push('', '## Symbols');
      if (syms.length > maxSymbols) lines.push(`(showing ${maxSymbols}/${syms.length} — refine with kind/filter/max_symbols)`);
      lines.push(renderSymbolTree(syms as OutlineSymbol[], maxSymbols) || '(no symbols)');
      return lines.join('\n');
    }

    const symbols = applyFilters(db.getSymbolsByFile(project.id, filePath));

    // Regex fallback for files the structural pass under-extracted.
    const extras: OutlineSymbol[] = [];
    if (symbols.length < 3 && file.line_count > 80 && !kindFilter && !nameFilter) {
      try {
        const known = new Set(symbols.map((s) => `${s.line}:${s.name}`));
        for (const e of extractSkeletonFromFile(join(project.root_path, filePath))) {
          if (known.has(`${e.line}:${e.name}`)) continue;
          extras.push({ line: e.line, kind: e.kind, name: e.name });
        }
      } catch { /* ignore */ }
    }

    const all: OutlineSymbol[] = [
      ...symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line, parent: s.parent })),
      ...extras,
    ];

    const lines = [`# ${filePath} · ${file.line_count} lines · ${file.language}`];
    const role = inferFileRole(filePath);
    if (role) lines.push(`Role: ${role}`);
    if (file.summary) lines.push(`Summary: ${file.summary}`); // populated by `code-context enrich`

    const imports = joinCapped(db.getDependencies(file.id, project.id).map((d) => d.import_path));
    const exports = joinCapped(symbols.filter((s) => s.exported && !s.parent).map((s) => s.name));
    if (imports || exports) {
      lines.push('');
      if (imports) lines.push(`Imports: ${imports}`);
      if (exports) lines.push(`Exports: ${exports}`);
    }

    lines.push('', '## Symbols');
    if (all.length > maxSymbols) lines.push(`(showing ${maxSymbols}/${all.length} — refine with kind/filter/max_symbols)`);
    lines.push(renderSymbolTree(all, maxSymbols) || '(no symbols)');
    return lines.join('\n');
  }),
});

const read_file = defineTool({
  name: 'read_file',
  description:
    'Read a file slice with smart defaults. Auto-returns the whole file when it has ≤800 lines (no pagination needed for most source files).\n' +
    '\n' +
    'Decision tree (follow this BEFORE calling read_file):\n' +
    '1. Don\'t know total_lines? → call get_file_skeleton FIRST. It returns file size + outline in <100 tokens.\n' +
    '2. File ≤800 lines → read_file returns the whole file in one call (auto-full).\n' +
    '3. File >800 + you know the symbol name → pass `symbol: "<name>"` (or call get_symbol_body).\n' +
    '4. File >800 + you have a stack frame / grep hit → pass `around_line: <n>` to get the enclosing function.\n' +
    '5. File >800 + you know a string → pass `search_term:` to center the window on the first match.\n' +
    '6. File >800 + you need everything → pass `force: true` (returns the full file in one call).\n' +
    '\n' +
    'NEVER: paginate more than twice on the same file. After 2 calls without finding what you need, switch tactics (skeleton, symbol, grep, force). The doom-loop guard aborts repetitive turns.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      file_path: { type: 'string' },
      symbol: {
        type: 'string',
        description: 'Return only the body of this symbol (function/class/etc.). Wins over start_line/end_line/search_term when set.',
      },
      around_line: {
        type: 'number',
        description: 'Return the symbol body that contains this 1-indexed line. Useful when you have a stack frame or grep hit.',
      },
      search_term: { type: 'string', description: 'Center the read window around the first match of this regex (case-insensitive).' },
      start_line: { type: 'number' },
      end_line: { type: 'number' },
      max_lines: { type: 'number', description: 'Default 400.' },
      force: { type: 'boolean', description: 'Return the full file in one call. Use for files >800 lines when you need everything.' },
      force_reread: {
        type: 'boolean',
        description:
          'Bypass the duplicate-result marker. Set true ONLY when you believe the file changed since a previous read. Orthogonal to `force` — `force` controls truncation (size), `force_reread` controls cache (skip the dup-content marker). Default false.',
      },
    },
    required: ['project_name', 'file_path'],
  },
  handler: withProject((args, { db }, project) => {
    const filePath = normalizeFilePath(args.file_path as string, project.root_path);
    const file = db.getFile(project.id, filePath);
    const abs = join(project.root_path, filePath);
    const AUTO_FULL_THRESHOLD = 800;

    // Symbol-targeted modes (shared by both DB-indexed and disk-fallback paths).
    // Loads full content once and extracts only the requested symbol body.
    const symbolArg = typeof args.symbol === 'string' ? (args.symbol as string).trim() : '';
    const aroundLine = typeof args.around_line === 'number' ? (args.around_line as number) : null;
    if (symbolArg || aroundLine !== null) {
      let content: string;
      try { content = readFileSync(abs, 'utf-8'); } catch (e) {
        throw new Error(
          `File "${filePath}" not found on disk: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const totalLines = content.split('\n').length;
      let anchor: number | null = null;
      if (symbolArg) {
        anchor = findSymbolDeclLineFromContent(content, symbolArg);
        if (anchor === null) {
          throw new Error(
            `Symbol '${symbolArg}' not found in ${filePath}. Fall back to a line range, search_term, or grep first.`,
          );
        }
      } else if (aroundLine !== null) {
        anchor = findEnclosingDeclLine(content, aroundLine);
      }
      if (anchor !== null) {
        const body = extractSymbolBodyFromContent(filePath, content, anchor);
        const header = `${filePath} — symbol body (lines ${body.start_line}-${body.end_line} of ${totalLines})\n`;
        return header + body.body;
      }
    }

    // Disk fallback: file exists on disk but isn't in the index. Read it
    // directly so the agent gets the content in non-indexed projects and
    // for files created in this session. Surface a tag so the model knows
    // it's seeing fallback output.
    if (!file) {
      let stat: { isFile(): boolean; size: number };
      try { stat = statSync(abs); } catch {
        throw new Error(
          `File "${filePath}" not found in index nor on disk. Use list_directory or search to find the correct path. Do not retry with the same file_path.`,
        );
      }
      if (!stat.isFile()) {
        throw new Error(
          `Path "${filePath}" exists but is a directory. Use list_directory on it instead.`,
        );
      }
      const startLineArg = args.start_line as number | undefined;
      const endLineArg = args.end_line as number | undefined;
      let startLine = startLineArg ?? 1;
      const maxLines = (args.max_lines as number | undefined) ?? 400;
      const autoFull = process.env.CODER_READ_FILE_AUTOFULL_DISABLE !== '1';
      try {
        const content = readFileSync(abs, 'utf-8');
        const lines = content.split('\n');
        const total = lines.length;
        const force = args.force === true;
        const isAutoFull = autoFull && !args.search_term && startLineArg === undefined && endLineArg === undefined && total <= AUTO_FULL_THRESHOLD;

        let headerNote = '';
        if (typeof args.search_term === 'string' && args.search_term.length > 0 && !isAutoFull) {
          const term = args.search_term as string;
          try {
            const re = new RegExp(term, 'i');
            const idx = lines.findIndex((l) => re.test(l));
            if (idx === -1) return `[Search term "${term}" not found in ${filePath}. Use grep_code to search across files.]`;
            startLine = Math.max(1, idx + 1 - Math.floor(maxLines / 2));
            headerNote = `[Auto-scrolled to line ${idx + 1} matching "${term}"]\n`;
          } catch (e) {
            return `Invalid search_term regex: ${(e as Error).message}`;
          }
        }

        const endLine = endLineArg ?? ((force || isAutoFull) ? total : Math.min(total, startLine + maxLines - 1));
        const slice = lines.slice(startLine - 1, endLine);
        const numbered = slice.map((l, i) => `${startLine + i}\t${l}`).join('\n');
        const ext = filePath.split('.').pop() ?? '';
        const tag = isAutoFull
          ? ' [auto-full: file ≤800 lines]'
          : endLine < total && total > AUTO_FULL_THRESHOLD
            ? ' [auto-full off — file > 800 lines, pass force=true to read all]'
            : '';
        const header = `${filePath} | ${total} lines | ${ext} | [disk fallback — file not indexed]\n[lines ${startLine}-${endLine}]${tag}\n`;
        const remaining = total - endLine;
        const footer = remaining > 0 ? `\n... [${remaining} more lines — pass force=true, symbol, around_line, or search_term]` : '';
        return header + headerNote + numbered + footer;
      } catch (e) {
        throw new Error(`Failed to read ${filePath} from disk: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const startLine = args.start_line as number | undefined;
    const endLine = args.end_line as number | undefined;
    const maxLines = (args.max_lines as number) ?? 400;
    const force = args.force === true;
    const autoFull = process.env.CODER_READ_FILE_AUTOFULL_DISABLE !== '1';
    let start = startLine ?? 1;
    let headerNote = '';

    // Auto-full: when the file fits in AUTO_FULL_THRESHOLD lines AND the
    // caller didn't explicitly opt out via env, return the whole thing in a
    // single response. This is the single biggest lever against pagination
    // loops — most source files are <800 lines.
    const isAutoFull =
      autoFull &&
      !args.search_term &&
      startLine === undefined &&
      endLine === undefined &&
      file.line_count <= AUTO_FULL_THRESHOLD;

    if (typeof args.search_term === 'string' && args.search_term.length > 0 && !isAutoFull) {
      const term = args.search_term as string;
      try {
        const content = readFileSync(abs, 'utf-8');
        const lines = content.split('\n');
        const re = new RegExp(term, 'i');
        const idx = lines.findIndex((l) => re.test(l));
        if (idx === -1) {
          return `[Search term "${term}" not found in ${filePath}. Use grep_code to search across files.]`;
        }
        start = Math.max(1, idx + 1 - Math.floor(maxLines / 2));
        headerNote = `[Auto-scrolled to line ${idx + 1} matching "${term}"]\n`;
      } catch (e) {
        return `Failed to read file for search_term: ${(e as Error).message}`;
      }
    }

    const defaultEnd = (force || isAutoFull)
      ? file.line_count
      : Math.min(file.line_count, start + maxLines - 1);
    const end = endLine ?? defaultEnd;
    try {
      const slice = readFileSlice(abs, start, end);
      const ext = filePath.split('.').pop() ?? '';
      // Enforce a char budget HERE so the header always reports the range we
      // actually return. Otherwise force=true builds a [lines 1-867] header and
      // the generic output cap byte-slices the body, leaving the header lying.
      const BUDGET = 22_000;
      let kept = slice.lines;
      let effEnd = end;
      let budgetTrimmed = false;
      let acc = 0;
      for (let i = 0; i < slice.lines.length; i++) {
        const rendered = `${start + i}\t${slice.lines[i]}\n`.length;
        if (acc + rendered > BUDGET && i > 0) {
          kept = slice.lines.slice(0, i);
          effEnd = start + i - 1;
          budgetTrimmed = true;
          break;
        }
        acc += rendered;
      }
      const numbered = kept.map((l, i) => `${start + i}\t${l}`).join('\n');
      const remaining = file.line_count - effEnd;
      const tag = isAutoFull && !budgetTrimmed
        ? ' [auto-full: file ≤800 lines]'
        : remaining > 0 && file.line_count > AUTO_FULL_THRESHOLD
          ? ' [auto-full off — file > 800 lines, pass force=true to read all]'
          : '';
      const richHeader = `${filePath} | ${file.line_count} lines | ${ext}${file.layer ? ` | layer=${file.layer}` : ''}\n[lines ${start}-${effEnd}]${tag}\n`;
      const footer = remaining > 0
        ? budgetTrimmed
          ? `\n... [${remaining} more lines — output capped; pass start_line=${effEnd + 1} to continue]`
          : `\n... [${remaining} more lines — pass force=true, symbol, around_line, or search_term]`
        : '';
      return richHeader + headerNote + numbered + footer;
    } catch (e) {
      return `Failed: ${(e as Error).message}`;
    }
  }),
});

const list_directory = defineTool({
  name: 'list_directory',
  description: 'List files under a path prefix. Reads from the index when populated; falls back to a bounded disk scan when the index has nothing for the path (project not indexed, or directory created in this session).',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, path: { type: 'string' }, depth: { type: 'number' } },
    required: ['project_name'],
  },
  handler: withProject((args, { db }, project) => {
    const prefix = (args.path as string | undefined) ?? '';
    const depth = (args.depth as number) ?? 2;
    const files = db.listFiles(project.id);
    const baseDepth = prefix ? prefix.split('/').filter(Boolean).length : 0;
    const filtered = files.filter(f => !prefix || f.path.startsWith(prefix));
    const out: string[] = [];
    for (const f of filtered) {
      const parts = f.path.split('/');
      if (parts.length - baseDepth > depth + 1) continue;
      out.push(`${f.path} (${f.line_count}L)`);
    }
    if (out.length > 0) {
      return out.slice(0, 200).join('\n');
    }
    // Disk fallback: index is empty for this prefix. Walk the directory
    // directly so the agent gets useful results in non-indexed projects
    // and on freshly created paths.
    const diskEntries = listDirectoryFromDisk(project.root_path, prefix, depth);
    if (diskEntries.length === 0) {
      return 'Empty.';
    }
    return `[disk fallback — index has no entries for this path]\n` + diskEntries.slice(0, 200).join('\n');
  }),
});

/**
 * Bounded recursive directory listing for the disk fallback. Skips the same
 * standard ignore dirs the project scanner uses so we don't dump
 * `node_modules` into the result. Lines mirror the indexed format
 * (`<rel-path> (<size>B)`) so the LLM doesn't need to special-case the
 * fallback output.
 */
function listDirectoryFromDisk(rootPath: string, prefix: string, depth: number): string[] {
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.mcp-indexer', '.cache', '.turbo', 'coverage']);
  const startAbs = prefix ? join(rootPath, prefix) : rootPath;
  let stat: { isDirectory(): boolean };
  try { stat = statSync(startAbs); } catch { return []; }
  if (!stat.isDirectory()) {
    // The prefix points at a file: report just that one.
    try {
      const fileStat = statSync(startAbs);
      const norm = prefix.replace(/\\/g, '/');
      return [`${norm} (${fileStat.size}B)`];
    } catch { return []; }
  }
  const out: string[] = [];
  const walk = (absDir: string, relDir: string, level: number): void => {
    if (level > depth) return;
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[] = [];
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= 500) return;
      if (IGNORE.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const childAbs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        out.push(`${childRel}/`);
        walk(childAbs, childRel, level + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try { size = statSync(childAbs).size; } catch { /* ignore */ }
        out.push(`${childRel} (${size}B)`);
      }
    }
  };
  walk(startAbs, prefix, 0);
  return out;
}

const get_recently_modified_files = defineTool({
  name: 'get_recently_modified_files',
  description: 'List recently indexed/modified files.',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, limit: { type: 'number' } },
    required: ['project_name'],
  },
  handler: withProject((args, { db }, project) => {
    const limit = (args.limit as number) ?? 20;
    const files = db.listFiles(project.id)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, limit);
    return files.map(f => `${f.updated_at} ${f.path} (${f.line_count}L)`).join('\n') || 'No files.';
  }),
});

const get_dependencies = defineTool({
  name: 'get_dependencies',
  description: 'Get file dependencies (imports)',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, file_path: { type: 'string' } },
    required: ['project_name', 'file_path'],
  },
  handler: withProject((args, { db }, project) => {
    const filePath = normalizeFilePath(args.file_path as string, project.root_path);
    const file = db.getFile(project.id, filePath);
    if (!file) throw new Error(`File "${filePath}" not found in index. Use list_directory or search to find the correct path. Do not retry with the same file_path.`);
    const deps = db.getDependencies(file.id, project.id);
    return deps.map(d => `${d.dep_type} ${d.import_path}${d.target_file_path ? ` → ${d.target_file_path}` : ''}`).join('\n') || 'No dependencies found.';
  }),
});

const get_dependents = defineTool({
  name: 'get_dependents',
  description: 'Get files that depend on a given file',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, file_path: { type: 'string' } },
    required: ['project_name', 'file_path'],
  },
  handler: withProject((args, { db }, project) => {
    const filePath = normalizeFilePath(args.file_path as string, project.root_path);
    const file = db.getFile(project.id, filePath);
    if (!file) throw new Error(`File "${filePath}" not found in index. Use list_directory or search to find the correct path. Do not retry with the same file_path.`);
    const deps = db.getDependents(project.id, file.id);
    return deps.map(d => `${d.source_file_path} (${d.import_path})`).join('\n') || 'No dependents found.';
  }),
});

export const fileTools: McpTool[] = [
  get_file_structure,
  get_file_skeleton,
  read_file,
  list_directory,
  get_recently_modified_files,
  get_dependencies,
  get_dependents,
];
