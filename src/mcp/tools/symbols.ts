import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineTool, type McpTool } from '../tool.js';
import {
  extractSymbolBody,
  grepInFiles,
  findSymbolDeclLine,
  locateSymbolInFiles,
} from '@ctx/services/services/code-reader.js';
import { treeSitterSymbols } from '@ctx/indexer/indexer/incremental.js';
import type { DBSymbol } from '@ctx/shared/types.js';
import { withProject } from './_helpers.js';
import { scanDiskForGrep } from './search.js';

/**
 * Disk-only fallback that locates a symbol's defining file/line/body without
 * touching the symbol DB. Used by find_references / prepare_edit / trace_usage
 * when the project is not indexed (or the symbol is too new for the DB).
 *
 * Returns null when no candidate file matches.
 */
async function findSymbolOnDisk(
  projectRoot: string,
  symbolName: string,
  hintPath?: string,
): Promise<{
  file: string;
  line: number;
  body: { start_line: number; end_line: number; body: string } | null;
  fileSymbols: Array<{ name: string; kind: string; line: number; signature: string }>;
} | null> {
  const candidateFiles = hintPath ? [hintPath] : await scanDiskForGrep(projectRoot, '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,cs,kt,swift,rb,php,c,h,cpp,hpp}');
  const located = locateSymbolInFiles(projectRoot, candidateFiles, symbolName);
  if (!located) return null;
  const abs = join(projectRoot, located.file);
  let content: string;
  try { content = readFileSync(abs, 'utf-8'); } catch { return null; }
  let body: { start_line: number; end_line: number; body: string } | null = null;
  try {
    const b = extractSymbolBody(projectRoot, located.file, located.line);
    body = { start_line: b.start_line, end_line: b.end_line, body: b.body };
  } catch { /* ignore */ }
  const ts = await treeSitterSymbols(located.file, content);
  const fileSymbols = (ts?.symbols ?? []).map((s) => ({
    name: s.name,
    kind: s.kind,
    line: s.line,
    signature: s.signature,
  }));
  return { file: located.file, line: located.line, body, fileSymbols };
}

/**
 * Disk-only caller search. Greps the project tree for `\bname\b` and reports
 * raw text hits. The `excludeFile` and `excludeLine` args drop the symbol's
 * own definition line so it doesn't masquerade as a caller.
 */
async function findCallersOnDisk(
  projectRoot: string,
  symbolName: string,
  excludeFile: string | null,
  excludeLine: number | null,
  max: number,
): Promise<Array<{ file: string; line: number; text: string }>> {
  const files = await scanDiskForGrep(projectRoot, '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,cs,kt,swift,rb,php,c,h,cpp,hpp}');
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`);
  const hits = grepInFiles(projectRoot, files, re, max + 5);
  return hits
    .filter((h) => !(h.file === excludeFile && h.line === excludeLine))
    .slice(0, max);
}

const get_symbol_details = defineTool({
  name: 'get_symbol_details',
  description: 'Get symbol details by ID',
  inputSchema: {
    type: 'object',
    properties: {
      symbol_id: { type: 'number' },
      project_name: { type: 'string', description: 'Project that owns the symbol — needed to resolve the id when per-project DBs are split.' },
    },
    required: ['symbol_id'],
  },
  handler: (args, { db }) => {
    // Surrogate ids are unique only within a project DB post-split; resolve the
    // owning project when given (central fallback keeps the pre-split behavior).
    const project = args.project_name ? db.getProjectByName(args.project_name as string) : undefined;
    const sym = db.getSymbolById(args.symbol_id as number, project?.id);
    if (!sym) throw new Error(`Symbol with id ${args.symbol_id} not found. Use search or get_file_skeleton to find valid symbol IDs. Do not retry with the same symbol_id.`);
    const tags = JSON.parse(sym.tags) as string[];
    const refs = db.getSymbolCallers(sym.project_id, sym.name);
    const rels = db.getSymbolRelations(sym.id, sym.project_id);

    const sections = [
      `# ${sym.kind} \`${sym.name}\``,
      `Signature: \`${sym.signature}\``,
      `File: ${sym.file_path}:${sym.line ?? '?'}`,
      sym.parent ? `Parent: ${sym.parent}` : '',
      sym.comment ? `\n## Description\n${sym.comment}` : '',
      tags.length > 0 ? `Tags: ${tags.join(', ')}` : '',
    ].filter(Boolean);

    if (rels.length > 0) {
      sections.push('', '## Relations', rels.map(r => `- ${r.relation_type}: ${r.related_symbol_name}`).join('\n'));
    }
    if (refs.length > 0) {
      sections.push('', '## Referenced by', refs.map(r => `- ${r.referencing_file_path}:${r.line ?? '?'}${r.context ? ` — ${r.context}` : ''}`).join('\n'));
    }
    return sections.join('\n');
  },
});

const get_class_members = defineTool({
  name: 'get_class_members',
  description: 'Get members of a class',
  inputSchema: {
    type: 'object',
    properties: { class_name: { type: 'string' }, project_name: { type: 'string' } },
    required: ['class_name', 'project_name'],
  },
  handler: withProject((args, { db }, project) => {
    const members = db.getClassMembers(args.class_name as string, project.id);
    return members.map(m => `  ${m.kind} ${m.name} — ${m.signature}`).join('\n') || 'No members found.';
  }),
});

const find_references = defineTool({
  name: 'find_references',
  description: 'Find all files that reference a symbol. When the symbol name is ambiguous, the response includes a list of candidate definitions; pass file_path to scope references to a specific definition.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      symbol_name: { type: 'string' },
      file_path: { type: 'string', description: 'Optional, for disambiguation when symbol_name is defined in multiple files' },
      force_reread: {
        type: 'boolean',
        description: 'Bypass the duplicate-result check. Use ONLY when you legitimately believe the underlying data changed since a previous fetch (file edited, index re-built). Default false.',
      },
    },
    required: ['project_name', 'symbol_name'],
  },
  handler: withProject(async (args, { db }, project) => {
    const symbolName = args.symbol_name as string;
    const filePath = args.file_path as string | undefined;
    const asJson = args.format === 'json';

    const candidates = db.findSymbolsByName(project.id, symbolName);
    const ambiguous = candidates.length > 1 && !filePath;

    const refs = db.getSymbolCallers(project.id, symbolName);
    if (refs.length > 0) {
      if (asJson) {
        return JSON.stringify({
          symbol_name: symbolName,
          source: 'db',
          ambiguous,
          candidates: ambiguous
            ? candidates.slice(0, 10).map(c => ({
                file_path: c.file_path,
                line: c.line,
                kind: c.kind,
              }))
            : undefined,
          total: refs.length,
          references: refs.map(r => ({
            file_path: r.referencing_file_path,
            line: r.line,
            context: r.context,
          })),
        });
      }
      const defBlock: string[] = [];
      if (ambiguous) {
        defBlock.push(`[note] '${symbolName}' is defined in ${candidates.length} files:`);
        for (const c of candidates.slice(0, 10)) {
          defBlock.push(`  - ${c.file_path}:${c.line ?? '?'} [${c.kind}]`);
        }
        defBlock.push('Pass file_path to scope references to a specific definition.');
        defBlock.push('');
      }
      return defBlock.join('\n') + refs.map(r => `${r.referencing_file_path}:${r.line ?? '?'}${r.context ? `: ${r.context}` : ''}`).join('\n');
    }
    // Fallback: grep the project files directly. Prefer the indexed file
    // list; when empty (project never indexed), scan the disk so the agent
    // still gets useful results instead of an empty response.
    const allFiles = db.listFiles(project.id).map(f => f.path);
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`);
    let hits = grepInFiles(project.root_path, allFiles, pattern, 50);
    let usedDisk = false;
    if (hits.length === 0) {
      const diskFiles = await scanDiskForGrep(project.root_path, '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,cs,kt,swift,rb,php,c,h,cpp,hpp}');
      hits = grepInFiles(project.root_path, diskFiles, pattern, 50);
      usedDisk = hits.length > 0;
    }
    if (asJson) {
      return JSON.stringify({
        symbol_name: symbolName,
        source: usedDisk ? 'disk_grep_fallback' : 'grep_fallback',
        ambiguous,
        total: hits.length,
        references: hits.map(h => ({ file_path: h.file, line: h.line, context: h.text })),
      });
    }
    if (hits.length === 0) return 'No references found.';
    const tag = usedDisk
      ? '[disk-grep fallback — project not indexed; results from on-disk scan]'
      : '[grep fallback — symbol_references DB empty]';
    return `${tag}\n` +
      hits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n');
  }),
});

const get_hierarchy = defineTool({
  name: 'get_hierarchy',
  description: 'Get class/interface hierarchy (extends, implements, subclasses)',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      symbol_name: { type: 'string' },
      force_reread: {
        type: 'boolean',
        description: 'Bypass the duplicate-result check. Use ONLY when you legitimately believe the underlying data changed since a previous fetch (file edited, index re-built). Default false.',
      },
    },
    required: ['project_name', 'symbol_name'],
  },
  handler: withProject((args, { db }, project) => {
    const hierarchy = db.getSymbolHierarchy(project.id, args.symbol_name as string);
    const lines: string[] = [];
    if (hierarchy.extends_chain.length > 0) lines.push(`Extends: ${hierarchy.extends_chain.join(' → ')}`);
    if (hierarchy.implements_list.length > 0) lines.push(`Implements: ${hierarchy.implements_list.join(', ')}`);
    if (hierarchy.subclasses.length > 0) lines.push(`Subclasses: ${hierarchy.subclasses.join(', ')}`);
    if (hierarchy.implementors.length > 0) lines.push(`Implementors: ${hierarchy.implementors.join(', ')}`);
    return lines.join('\n') || 'No hierarchy information found.';
  }),
});

const find_implementations = defineTool({
  name: 'find_implementations',
  description: 'Find implementations of an interface',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      interface_name: { type: 'string' },
      force_reread: {
        type: 'boolean',
        description: 'Bypass the duplicate-result check. Use ONLY when you legitimately believe the underlying data changed since a previous fetch (file edited, index re-built). Default false.',
      },
    },
    required: ['project_name', 'interface_name'],
  },
  handler: withProject((args, { db }, project) => {
    const impls = db.getImplementors(project.id, args.interface_name as string);
    return impls.map(s => `${s.kind} ${s.name} — ${s.file_path}:${s.line ?? '?'}`).join('\n') || 'No implementations found.';
  }),
});

const trace_usage = defineTool({
  name: 'trace_usage',
  description: 'Trace the full usage tree of a symbol (who calls it, and who calls those callers)',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      symbol_name: { type: 'string' },
      depth: { type: 'number', description: 'Max depth (default 3)' },
      force_reread: {
        type: 'boolean',
        description: 'Bypass the duplicate-result check. Use ONLY when you legitimately believe the underlying data changed since a previous fetch (file edited, index re-built). Default false.',
      },
    },
    required: ['project_name', 'symbol_name'],
  },
  handler: withProject(async (args, { db }, project) => {
    const depth = (args.depth as number) ?? 3;
    const symbolName = args.symbol_name as string;
    const tree = db.traceSymbolUsage(project.id, symbolName, depth);

    // Disk fallback: when the index has no record of the symbol, walk the
    // project tree and report direct callers via grep. Depth>1 isn't viable
    // without a caller graph, so we cap at 1 and tell the agent why.
    if (!tree.defined_in && tree.callers.length === 0) {
      const located = await findSymbolOnDisk(project.root_path, symbolName);
      const callers = await findCallersOnDisk(
        project.root_path,
        symbolName,
        located?.file ?? null,
        located?.line ?? null,
        20,
      );
      const lines: string[] = [
        `# Usage Tree: \`${symbolName}\``,
        located ? `Defined in: ${located.file}:${located.line} [tree-sitter fallback]` : 'Definition not found in index nor on disk',
        '',
      ];
      if (callers.length === 0) {
        lines.push('No usages found.');
      } else {
        lines.push(`## Callers (depth: 1, disk-grep fallback — project not indexed)`);
        for (const c of callers) {
          lines.push(`- **${c.file}**:${c.line}: ${c.text}`);
        }
        if (depth > 1) {
          lines.push('');
          lines.push(`[note] requested depth=${depth} but disk fallback only supports depth=1 — re-index the project for full caller-graph traversal.`);
        }
      }
      return lines.join('\n');
    }

    const formatTree = (callers: typeof tree.callers, indent: string): string => {
      const MAX_CALLERS_PER_NODE = 5;
      const shownCallers = callers.slice(0, MAX_CALLERS_PER_NODE);
      const isTruncated = callers.length > MAX_CALLERS_PER_NODE;

      const result = shownCallers.map(c => {
        const lines = [`${indent}- **${c.file}**${c.line ? `:${c.line}` : ''}`];
        if (c.symbols_in_file.length > 0) {
          lines.push(`${indent}  Symbols here: ${c.symbols_in_file.map(s => `\`${s}\``).join(', ')}`);
        }
        if (c.callers.length > 0) {
          lines.push(`${indent}  Called by:`);
          lines.push(formatTree(c.callers as typeof tree.callers, indent + '    '));
        }
        return lines.join('\n');
      }).join('\n');

      if (isTruncated) {
          return result + `\n${indent}- [... and ${callers.length - MAX_CALLERS_PER_NODE} more callers omitted here to protect context limits. Use find_references on specific parents to drill down.]`;
      }
      return result;
    };

    const sections = [
      `# Usage Tree: \`${tree.symbol}\``,
      tree.defined_in ? `Defined in: ${tree.defined_in}` : 'Definition not found in index',
      '',
    ];
    if (tree.callers.length === 0) {
      sections.push('No usages found.');
    } else {
      sections.push(`## Callers (depth: ${depth})`);
      sections.push(formatTree(tree.callers, ''));
    }
    return sections.join('\n');
  }),
});

const get_symbol_body = defineTool({
  name: 'get_symbol_body',
  description: 'Extract just the body (line range) of a symbol — token-cheap alternative to reading the whole file.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      symbol_name: { type: 'string' },
      file_path: { type: 'string', description: 'Optional, for disambiguation' },
      force_reread: {
        type: 'boolean',
        description: 'Bypass the duplicate-result check. Use ONLY when you legitimately believe the underlying data changed since a previous fetch (file edited, index re-built). Default false.',
      },
    },
    required: ['project_name', 'symbol_name'],
  },
  handler: withProject((args, { db }, project) => {
    const symbolName = args.symbol_name as string;
    const filePath = args.file_path as string | undefined;
    const asJson = args.format === 'json';

    let sym: DBSymbol | undefined;
    let ambiguityNote = '';
    if (filePath) {
      sym = db.findSymbolByName(project.id, symbolName, { filePath });
    } else {
      const candidates = db.findSymbolsByName(project.id, symbolName);
      if (candidates.length > 1 && asJson) {
        return JSON.stringify({
          error: 'ambiguous',
          symbol_name: symbolName,
          total: candidates.length,
          candidates: candidates.slice(0, 10).map(c => ({
            file_path: c.file_path,
            line: c.line,
            kind: c.kind,
          })),
        });
      }
      sym = candidates[0];
      // Text mode previously returned the first of N defs silently — surface the
      // ambiguity like find_references/prepare_edit do.
      if (candidates.length > 1) {
        ambiguityNote =
          `[note] '${symbolName}' is defined in ${candidates.length} files — showing the first; pass file_path to pick another:\n` +
          candidates.slice(0, 8).map(c => `  - ${c.file_path}:${c.line ?? '?'} [${c.kind}]`).join('\n') +
          '\n\n';
      }
    }

    let targetFile: string | null = sym?.file_path ?? filePath ?? null;
    let targetLine: number | null = sym?.line ?? null;
    let usedFallback = false;

    if (targetFile && !targetLine) {
      targetLine = findSymbolDeclLine(join(project.root_path, targetFile), symbolName);
      if (targetLine) usedFallback = true;
    }
    if (!targetFile || !targetLine) {
      const allFiles = db.listFiles(project.id).map(f => f.path);
      const located = locateSymbolInFiles(project.root_path, allFiles, symbolName);
      if (located) {
        targetFile = located.file;
        targetLine = located.line;
        usedFallback = true;
      }
    }
    if (!targetFile || !targetLine) {
      throw new Error(
        `Symbol "${symbolName}" not found. Use search or get_file_skeleton to find the correct symbol name. ` +
        `If you already know the file path but the index is stale, call native read_file({ path, symbol: "${symbolName}" }) — it runs the same regex+brace fallback straight from disk. Do not retry with the same arguments.`,
      );
    }
    try {
      const result = extractSymbolBody(project.root_path, targetFile, targetLine);
      if (asJson) {
        return JSON.stringify({
          symbol_name: symbolName,
          file_path: result.file,
          start_line: result.start_line,
          end_line: result.end_line,
          body: result.body,
          used_fallback: usedFallback,
        });
      }
      const note = usedFallback ? ' [regex fallback]' : '';
      return `${ambiguityNote}${result.file}:${result.start_line}-${result.end_line}${note}\n\n${result.body}`;
    } catch (e) {
      const msg = (e as Error).message;
      return asJson
        ? JSON.stringify({ error: 'read_failed', message: msg })
        : `Failed to read body: ${msg}`;
    }
  }),
});

const prepare_edit = defineTool({
  name: 'prepare_edit',
  description: 'One-shot context bundle for editing a symbol: body + callers + neighbors + imports + tests. Replaces 5+ separate calls. Callers are capped by max_callers (default 10) and sorted by proximity (same file > same dir > rest). If the symbol name is ambiguous, returns candidate list — pass file_path to disambiguate.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      symbol_name: { type: 'string' },
      file_path: { type: 'string', description: 'Optional, for disambiguation when symbol_name is not unique' },
      max_callers: { type: 'number', description: 'Max callers listed (default 10)' },
      force_reread: {
        type: 'boolean',
        description: 'Bypass the duplicate-result check. Use ONLY when you legitimately believe the underlying data changed since a previous fetch (file edited, index re-built). Default false.',
      },
    },
    required: ['project_name', 'symbol_name'],
  },
  handler: withProject(async (args, { db }, project) => {
    const symbolName = args.symbol_name as string;
    const filePath = args.file_path as string | undefined;
    const maxCallers = (args.max_callers as number) ?? 10;
    const asJson = args.format === 'json';

    let sym = filePath
      ? db.findSymbolByName(project.id, symbolName, { filePath })
      : undefined;
    if (!sym) {
      const candidates = db.findSymbolsByName(project.id, symbolName);
      if (candidates.length === 0) {
        // Disk fallback: locate the symbol via tree-sitter + regex on disk,
        // build a slim prepare_edit-shaped bundle. Body, neighbors and a
        // disk-grep callers list — no imports/tests because those need DB
        // dependency tables that are populated only by the LLM indexer.
        const located = await findSymbolOnDisk(project.root_path, symbolName, filePath);
        if (!located) {
          throw new Error(
            `Symbol "${symbolName}" not found. Use search or get_file_skeleton to find the correct symbol name. ` +
            `If the project has not been indexed, call native read_file({ path, symbol: "${symbolName}" }) instead. Do not retry with the same arguments.`,
          );
        }
        const callers = await findCallersOnDisk(
          project.root_path,
          symbolName,
          located.file,
          located.line,
          maxCallers,
        );
        const targetIdx = located.fileSymbols.findIndex((s) => s.name === symbolName && s.line === located.line);
        const neighbors = targetIdx >= 0
          ? located.fileSymbols.slice(Math.max(0, targetIdx - 3), targetIdx + 4)
          : located.fileSymbols.slice(0, 6);
        if (asJson) {
          return JSON.stringify({
            symbol: { name: symbolName, kind: '?', signature: null, file_path: located.file, line: located.line },
            source: 'disk_fallback',
            body: located.body ? { file: located.file, ...located.body } : null,
            callers: {
              total: callers.length,
              shown: callers.length,
              truncated: false,
              items: callers.map((c) => ({ file_path: c.file, line: c.line, context: c.text })),
            },
            neighbors: neighbors.map((n) => ({
              name: n.name,
              kind: n.kind,
              line: n.line,
              is_target: n.name === symbolName && n.line === located.line,
            })),
            imports: [],
            tests_covering: [],
          });
        }
        const sectionsX: string[] = [
          `=== prepare_edit: ${symbolName} ===`,
          '[disk fallback — project not indexed; imports/tests omitted]',
          `file: ${located.file}:${located.body?.start_line ?? located.line}-${located.body?.end_line ?? located.line}`,
        ];
        if (located.body) sectionsX.push('\n[BODY]\n' + located.body.body);
        sectionsX.push(`\n[CALLERS] (${callers.length}, disk-grep)`);
        sectionsX.push(callers.map((c) => `${c.file}:${c.line}: ${c.text}`).join('\n') || 'none');
        sectionsX.push(`\n[NEIGHBORS]`);
        sectionsX.push(neighbors.map((n) => {
          const marker = n.name === symbolName && n.line === located.line ? ' <- target' : '';
          return `${String(n.line ?? '?').padStart(5)} ${n.kind} ${n.name}${marker}`;
        }).join('\n') || 'none');
        return sectionsX.join('\n');
      }
      if (candidates.length > 1 && !filePath) {
        if (asJson) {
          return JSON.stringify({
            error: 'ambiguous',
            symbol_name: symbolName,
            total: candidates.length,
            candidates: candidates.slice(0, 10).map(c => ({
              file_path: c.file_path,
              line: c.line,
              kind: c.kind,
              signature: c.signature,
            })),
          });
        }
        const list = candidates.slice(0, 10).map(
          c => `  - ${c.file_path}:${c.line ?? '?'} [${c.kind}] ${c.signature || c.name}`
        ).join('\n');
        return [
          `Ambiguous symbol '${symbolName}' — ${candidates.length} matches. Re-run with file_path to disambiguate:`,
          list,
          candidates.length > 10 ? `... and ${candidates.length - 10} more` : ''
        ].filter(Boolean).join('\n');
      }
      sym = candidates[0];
    }

    const sections: string[] = [`=== prepare_edit: ${symbolName} ===`];

    if (sym.line) {
      try {
        const body = extractSymbolBody(project.root_path, sym.file_path, sym.line);
        sections.push(`file: ${body.file}:${body.start_line}-${body.end_line}`);
        sections.push('\n[BODY]\n' + body.body);
      } catch { sections.push(`file: ${sym.file_path}:${sym.line}`); }
    }

    const allRefs = db.getSymbolCallers(project.id, symbolName);
    const targetDir = sym.file_path.split('/').slice(0, -1).join('/');
    const proximity = (p: string): number => {
      if (p === sym!.file_path) return 0;
      const dir = p.split('/').slice(0, -1).join('/');
      if (dir === targetDir) return 1;
      return 2;
    };
    const sortedRefs = [...allRefs].sort(
      (a, b) => proximity(a.referencing_file_path) - proximity(b.referencing_file_path)
    );
    const shownRefs = sortedRefs.slice(0, maxCallers);
    const truncatedNote = allRefs.length > maxCallers
      ? ` (showing ${shownRefs.length}/${allRefs.length}, ordered by proximity — use find_references for the full list)`
      : '';
    sections.push(`\n[CALLERS] (${allRefs.length})${truncatedNote}`);
    sections.push(
      shownRefs.map(r => `${r.referencing_file_path}:${r.line ?? '?'}${r.context ? `: ${r.context}` : ''}`).join('\n') || 'none'
    );

    const fileSyms = db.getSymbolsByFile(project.id, sym.file_path);
    const idx = fileSyms.findIndex(s => s.name === sym!.name && s.line === sym!.line);
    const neighbors = idx >= 0 ? fileSyms.slice(Math.max(0, idx - 3), idx + 4) : fileSyms.slice(0, 6);
    sections.push(`\n[NEIGHBORS]`);
    sections.push(neighbors.map(s => {
      const marker = s.name === sym!.name && s.line === sym!.line ? ' <- target' : '';
      return `${String(s.line ?? '?').padStart(5)} ${s.kind} ${s.name}${marker}`;
    }).join('\n'));

    const file = db.getFile(project.id, sym.file_path);
    let imports: string[] = [];
    let testFilePaths: string[] = [];
    if (file) {
      imports = JSON.parse(file.dependencies || '[]') as string[];
      sections.push(`\n[IMPORTS]\n${imports.join(', ') || 'none'}`);

      const dependents = db.getDependents(project.id, file.id);
      const testFiles = dependents.filter(d => {
        const df = db.getFile(project.id, d.source_file_path);
        return df?.is_test === 1;
      });
      testFilePaths = testFiles.slice(0, 5).map(t => t.source_file_path);
      sections.push(`\n[TESTS COVERING] (${testFiles.length})`);
      sections.push(testFilePaths.join('\n') || 'none');
    }

    if (asJson) {
      let body: { file: string; start_line: number; end_line: number; body: string } | null = null;
      if (sym.line) {
        try {
          body = extractSymbolBody(project.root_path, sym.file_path, sym.line);
        } catch { /* ignore */ }
      }
      return JSON.stringify({
        symbol: {
          name: sym.name,
          kind: sym.kind,
          signature: sym.signature,
          file_path: sym.file_path,
          line: sym.line,
        },
        body,
        callers: {
          total: allRefs.length,
          shown: shownRefs.length,
          truncated: allRefs.length > maxCallers,
          items: shownRefs.map(r => ({
            file_path: r.referencing_file_path,
            line: r.line,
            context: r.context,
          })),
        },
        neighbors: neighbors.map(n => ({
          name: n.name,
          kind: n.kind,
          line: n.line,
          is_target: n.name === sym!.name && n.line === sym!.line,
        })),
        imports,
        tests_covering: testFilePaths,
      });
    }

    return sections.join('\n');
  }),
});

const semantic_neighbors = defineTool({
  name: 'semantic_neighbors',
  description: 'Find top-K symbols semantically similar to a given symbol using vector search. Useful for discovering related implementations, helpers, or wrappers — complements grep_code when names differ but behavior is similar. Requires vector coverage (see get_project_pulse).',
  inputSchema: {
    type: 'object',
    properties: {
      symbol_id: { type: 'number', description: 'Seed symbol id. Use search_by_kind or get_file_skeleton to discover ids.' },
      project_name: { type: 'string', description: 'Project that owns the symbol — needed to resolve the id when per-project DBs are split.' },
      limit: { type: 'number', description: 'Max neighbors to return (default 10)' },
      force_reread: {
        type: 'boolean',
        description: 'Bypass the duplicate-result check. Use ONLY when you legitimately believe the vector index changed since a previous fetch. Default false.',
      },
    },
    required: ['symbol_id'],
  },
  handler: async (args, { db, embeddingService, vectorStore }) => {
    // Resolve the owning project DB for the surrogate id (central when absent).
    const seedProject = args.project_name ? db.getProjectByName(args.project_name as string) : undefined;
    const sym = db.getSymbolById(args.symbol_id as number, seedProject?.id);
    if (!sym) throw new Error(`Symbol with id ${args.symbol_id} not found. Use search or get_file_skeleton to find valid symbol IDs. Do not retry with the same symbol_id.`);

    if (!vectorStore || (embeddingService as { constructor: { name: string } }).constructor.name === 'NullEmbeddingService') {
      return `[unavailable] Vector search is not configured for this project. Use grep_code or find_references instead for ${sym.kind} \`${sym.name}\`.`;
    }

    const project = db.getProject(sym.project_id);
    if (!project) return 'Project not found for this symbol.';

    // Build the query text using the same template the indexer uses for
    // body embeddings — maximizes vector-space proximity to the seed.
    const queryText = `${sym.kind} ${sym.name}\n${sym.signature ?? ''}\n${sym.comment ?? ''}`;
    const { vector } = await embeddingService.embedQuery(queryText);
    if (vector.length === 0) return 'Failed to embed seed symbol.';

    const limit = (args.limit as number) ?? 10;
    // Over-fetch by 2 so we can drop the seed itself and still return `limit`.
    const matches = await vectorStore.search(vector, {
      topK: limit + 2,
      filter: { project_name: project.name, type: 'symbol_body' },
    });

    // If symbol_body coverage is thin, fall back to signature-level matches.
    let usable = matches;
    if (usable.length === 0) {
      usable = await vectorStore.search(vector, {
        topK: limit + 2,
        filter: { project_name: project.name, type: 'symbol' },
      });
    }

    const neighbors: string[] = [];
    for (const m of usable) {
      const refId = m.metadata.ref_id ? parseInt(m.metadata.ref_id, 10) : 0;
      if (!refId || refId === sym.id) continue;
      const n = db.getSymbolById(refId, sym.project_id);
      if (!n) continue;
      neighbors.push(`${m.score.toFixed(3)} ${n.file_path}:${n.line ?? '?'} ${n.kind} ${n.name}`);
      if (neighbors.length >= limit) break;
    }

    if (neighbors.length === 0) {
      return `No semantic neighbors found for ${sym.kind} ${sym.name}. Vector coverage may be incomplete — try reindexing.`;
    }

    return [
      `# Semantic neighbors of ${sym.kind} \`${sym.name}\` (${sym.file_path}:${sym.line ?? '?'})`,
      '',
      ...neighbors,
    ].join('\n');
  },
});

export const symbolTools: McpTool[] = [
  get_symbol_details,
  get_class_members,
  find_references,
  get_hierarchy,
  find_implementations,
  trace_usage,
  get_symbol_body,
  prepare_edit,
  semantic_neighbors,
];
