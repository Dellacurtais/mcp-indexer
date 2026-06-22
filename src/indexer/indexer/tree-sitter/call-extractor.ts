/**
 * Tree-sitter call-site extractor — the multi-language half of the call graph.
 *
 * `extractor.ts` already pulls symbols + import references from the AST. This
 * adds the missing piece: actual *call sites* (who invokes whom), resolved
 * syntactically against the names known in the file (locally-defined symbols
 * ∪ imported names). That filter is deliberate — without it every
 * `console.log` / `parseInt` would become a dangling `symbol_references` row
 * (the store inserts unresolved names with a NULL symbol_id).
 *
 * This is name-based (syntactic) resolution: AST-aware, so it ignores calls
 * inside comments/strings and resolves `obj.method()` to `method`, but it
 * can't disambiguate overloads across modules. For TS/JS, a future pass can
 * upgrade specific edges to type-accurate ones via the in-process LSP.
 */
import type Parser from 'web-tree-sitter';
import type { LLMReference, SymbolKind } from '@ctx/shared/types.js';

/** Call/instantiation node types per language family. */
const CALL_NODES: Record<string, string[]> = {
  typescript: ['call_expression', 'new_expression'],
  tsx:        ['call_expression', 'new_expression'],
  javascript: ['call_expression', 'new_expression'],
  python:     ['call'],
  go:         ['call_expression'],
  rust:       ['call_expression', 'macro_invocation'],
  java:       ['method_invocation', 'object_creation_expression'],
  csharp:     ['invocation_expression', 'object_creation_expression'],
  kotlin:     ['call_expression'],
  ruby:       ['call', 'method_call'],
  cpp:        ['call_expression'],
  c:          ['call_expression'],
  php:        ['function_call_expression', 'member_call_expression', 'scoped_call_expression', 'object_creation_expression'],
  swift:      ['call_expression'],
};

/** Identifier-ish leaf node types whose `.text` is a usable name. */
const ID_TYPES = new Set([
  'identifier', 'type_identifier', 'field_identifier', 'property_identifier',
  'simple_identifier', 'name', 'constant',
]);

const DEFAULT_MAX_CALLS = Number(process.env.MCP_INDEX_MAX_CALLS_PER_FILE ?? 400);

export function callNodeTypesFor(language: string): string[] {
  return CALL_NODES[language] ?? [];
}

/**
 * Walk down a callee subtree to the rightmost identifier so member access
 * resolves to the invoked member: `a.b.c()` → `c`, `pkg.Func()` → `Func`,
 * `new ns.Foo()` → `Foo`.
 */
function rightmostIdentifier(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  if (ID_TYPES.has(node.type)) return node.text;
  const named = node.namedChildren;
  for (let i = named.length - 1; i >= 0; i--) {
    const r = rightmostIdentifier(named[i]);
    if (r) return r;
  }
  return null;
}

/** Extract the callee name from a call/instantiation node. */
export function getCalleeName(node: Parser.SyntaxNode): string | null {
  const callee =
    node.childForFieldName('function') ??
    node.childForFieldName('constructor') ??
    node.childForFieldName('name') ??
    node.childForFieldName('type') ??
    node.namedChild(0);
  return rightmostIdentifier(callee);
}

/**
 * Extract call-site references from an AST, keeping only calls whose callee
 * name is in `knownNames`. Deduplicated by (name, line); capped per file.
 */
export function extractCalls(
  rootNode: Parser.SyntaxNode,
  language: string,
  knownNames: Set<string>,
  maxCalls: number = DEFAULT_MAX_CALLS,
): LLMReference[] {
  const callTypes = new Set(CALL_NODES[language] ?? []);
  if (callTypes.size === 0 || knownNames.size === 0) return [];

  const refs: LLMReference[] = [];
  const seen = new Set<string>();

  const walk = (node: Parser.SyntaxNode): void => {
    if (refs.length >= maxCalls) return;
    if (callTypes.has(node.type)) {
      const name = getCalleeName(node);
      if (name && knownNames.has(name)) {
        const line = node.startPosition.row + 1;
        const key = `${name}:${line}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push({
            symbol_name: name,
            kind: 'function' as SymbolKind,
            line,
            col: node.startPosition.column + 1,
            snippet: node.text.split('\n')[0]?.trim().slice(0, 120),
          });
        }
      }
    }
    for (const child of node.namedChildren) {
      if (refs.length >= maxCalls) break;
      walk(child);
    }
  };

  walk(rootNode);
  return refs;
}
