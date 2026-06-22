import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BRACE_LANGS = new Set(['ts', 'tsx', 'js', 'jsx', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'kt', 'swift', 'php', 'scala', 'dart']);
const INDENT_LANGS = new Set(['py', 'rb', 'yaml', 'yml']);

export interface SymbolBody {
  file: string;
  start_line: number;
  end_line: number;
  body: string;
}

export function readFileSlice(absPath: string, start: number, end: number): { lines: string[]; total: number } {
  const content = readFileSync(absPath, 'utf-8');
  const all = content.split('\n');
  const s = Math.max(1, start);
  const e = Math.min(all.length, end);
  return { lines: all.slice(s - 1, e), total: all.length };
}

export function extractSymbolBody(rootPath: string, relPath: string, line: number): SymbolBody {
  const absPath = join(rootPath, relPath);
  const content = readFileSync(absPath, 'utf-8');
  return extractSymbolBodyFromContent(relPath, content, line);
}

/**
 * Same as extractSymbolBody but operates on already-loaded content. Used by
 * tools that read via the filesystem port (sandbox-aware) before delegating
 * to the brace/indent matcher.
 */
export function extractSymbolBodyFromContent(relPath: string, content: string, line: number): SymbolBody {
  const lines = content.split('\n');
  const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
  let startIdx = Math.max(0, Math.min(line - 1, lines.length - 1));

  // Snap to nearest real declaration: if current line is empty/closing brace, scan forward up to 5 lines
  for (let i = 0; i < 5; i++) {
    const t = lines[startIdx]?.trim() ?? '';
    if (t && t !== '}' && t !== '});' && !t.startsWith('//') && !t.startsWith('*')) break;
    if (startIdx + 1 >= lines.length) break;
    startIdx++;
  }

  let endIdx: number;

  if (BRACE_LANGS.has(ext)) {
    endIdx = findBraceEnd(lines, startIdx);
  } else if (INDENT_LANGS.has(ext)) {
    endIdx = findIndentEnd(lines, startIdx);
  } else {
    endIdx = Math.min(lines.length - 1, startIdx + 80);
  }

  const body = lines
    .slice(startIdx, endIdx + 1)
    .map((l, i) => `${startIdx + 1 + i}\t${l}`)
    .join('\n');

  return {
    file: relPath,
    start_line: startIdx + 1,
    end_line: endIdx + 1,
    body,
  };
}

function findBraceEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let started = false;
  let inStr: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    inLineComment = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      const next = line[j + 1];
      if (inLineComment) break;
      if (inBlockComment) {
        if (c === '*' && next === '/') { inBlockComment = false; j++; }
        continue;
      }
      if (inStr) {
        if (c === '\\') { j++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '/' && next === '/') { inLineComment = true; break; }
      if (c === '/' && next === '*') { inBlockComment = true; j++; continue; }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '{') { depth++; started = true; }
      else if (c === '}') {
        depth--;
        if (started && depth === 0) return i;
      }
    }
    if (started && depth === 0 && i > startIdx) return i;
    if (i - startIdx > 500) return i;
  }
  return Math.min(lines.length - 1, startIdx + 80);
}

export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

export function grepInFiles(
  rootPath: string,
  relPaths: string[],
  pattern: RegExp,
  maxResults: number
): GrepHit[] {
  const hits: GrepHit[] = [];
  for (const rel of relPaths) {
    if (hits.length >= maxResults) break;
    let content: string;
    try { content = readFileSync(join(rootPath, rel), 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        hits.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
        if (hits.length >= maxResults) break;
      }
    }
  }
  return hits;
}

/**
 * Find the first line where a symbol is declared in a file (regex-based fallback).
 * Used when the indexed line is missing/wrong or for symbols not in the DB.
 */
export function findSymbolDeclLine(absPath: string, symbolName: string): number | null {
  let content: string;
  try { content = readFileSync(absPath, 'utf-8'); } catch { return null; }
  return findSymbolDeclLineFromContent(content, symbolName);
}

/**
 * Walk backward from a 1-indexed line and return the nearest declaration
 * line. Used by `read_file({ around_line })` to anchor on the enclosing
 * symbol when the model has a stack frame or grep hit and wants the whole
 * function. Falls back to the input line when no declaration is found
 * (the brace-matcher will then return a 1-line "body").
 */
export function findEnclosingDeclLine(content: string, line: number): number {
  const lines = content.split('\n');
  // Same set used by findSymbolDeclLine — keeps behavior consistent.
  const declRe = [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w+/,
    /^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/,
    /^\s*(?:export\s+)?interface\s+\w+/,
    /^\s*(?:export\s+)?type\s+\w+\s*=/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*[=:]/,
    // Method-shaped declaration; reject control-flow keywords so a line
     // like `if (x) {` doesn't anchor the search.
    /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?(?!if|for|while|switch|catch|return|do|else|with)\w+\s*\([^)]*\)\s*[:{]/,
    // Python / Ruby
    /^\s*def\s+\w+/,
    /^\s*class\s+\w+/,
    // Go
    /^\s*func\s+\w+/,
    /^\s*func\s*\([^)]*\)\s*\w+/,
    // Rust
    /^\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+/,
    /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+\w+/,
  ];
  const start = Math.max(0, Math.min(line - 1, lines.length - 1));
  for (let i = start; i >= 0; i--) {
    const text = lines[i];
    for (const re of declRe) {
      if (re.test(text)) return i + 1;
    }
  }
  return line;
}

/**
 * Same as findSymbolDeclLine but operates on already-loaded content.
 */
export function findSymbolDeclLineFromContent(content: string, symbolName: string): number | null {
  const lines = content.split('\n');
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match function/class/interface/method/const/let/var declarations
  const patterns = [
    new RegExp(`(?:^|\\s)(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`(?:^|\\s)(?:export\\s+)?(?:abstract\\s+)?class\\s+${escaped}\\b`),
    new RegExp(`(?:^|\\s)(?:export\\s+)?interface\\s+${escaped}\\b`),
    new RegExp(`(?:^|\\s)(?:export\\s+)?type\\s+${escaped}\\b`),
    new RegExp(`(?:^|\\s)(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(`(?:^|\\s)(?:public|private|protected|static|async)?\\s*${escaped}\\s*[(<:]`),
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      if (p.test(lines[i])) return i + 1;
    }
  }
  return null;
}

/**
 * Locate a symbol across multiple files in the project (regex fallback).
 * Returns first match: { file, line }.
 */
export function locateSymbolInFiles(
  rootPath: string,
  relPaths: string[],
  symbolName: string
): { file: string; line: number } | null {
  for (const rel of relPaths) {
    const line = findSymbolDeclLine(join(rootPath, rel), symbolName);
    if (line !== null) return { file: rel, line };
  }
  return null;
}

/**
 * Regex-based skeleton extractor — used as fallback when DB symbols are sparse.
 */
export interface SkeletonEntry { line: number; kind: string; name: string; signature: string }
export function extractSkeletonFromFile(absPath: string): SkeletonEntry[] {
  let content: string;
  try { content = readFileSync(absPath, 'utf-8'); } catch { return []; }
  const lines = content.split('\n');
  const out: SkeletonEntry[] = [];
  const patterns: Array<{ re: RegExp; kind: string }> = [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/, kind: 'function' },
    { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)\b/, kind: 'class' },
    { re: /^\s*(?:export\s+)?interface\s+(\w+)\b/, kind: 'interface' },
    { re: /^\s*(?:export\s+)?type\s+(\w+)\s*=/, kind: 'type' },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/, kind: 'const' },
    { re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/, kind: 'method' },
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { re, kind } of patterns) {
      const m = line.match(re);
      if (m && m[1] && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(m[1])) {
        out.push({ line: i + 1, kind, name: m[1], signature: line.trim().slice(0, 200) });
        break;
      }
    }
  }
  return out;
}

function findIndentEnd(lines: string[], startIdx: number): number {
  const baseIndent = lines[startIdx].match(/^\s*/)?.[0].length ?? 0;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= baseIndent) return i - 1;
  }
  return lines.length - 1;
}
