/**
 * Tree-sitter based symbol extractor.
 *
 * Walks the AST to extract symbols (functions, classes, interfaces, etc.),
 * import/export references, and file dependencies — replacing the LLM for
 * structural analysis while being free, deterministic, and fast (<15ms/file).
 *
 * Produces output compatible with LLMFileAnalysis so it plugs directly into
 * the existing IndexAgent pipeline.
 */
import Parser from 'web-tree-sitter';
import { basename, extname, dirname } from 'node:path';
import type { LLMSymbol, LLMReference, LLMFileAnalysis, SymbolKind } from '@ctx/shared/types.js';
import {
  getGrammarForExtension,
  isExtractable,
  createParser,
  initTreeSitter,
} from '@ctx/indexer/indexer/tree-sitter/languages.js';
import { extractCalls } from '@ctx/indexer/indexer/tree-sitter/call-extractor.js';

// ─── Types ───────────────────────────────────────────────────────

export interface TreeSitterResult {
  /** Structural analysis (symbols, refs, deps). No summary/concepts — those need LLM. */
  analysis: Partial<LLMFileAnalysis>;
  /** True if tree-sitter handled the language. False = fall back to LLM. */
  supported: boolean;
  /** Language detected from extension. */
  language: string;
}

// ─── Node type → SymbolKind mapping (per language family) ────────

/** TypeScript / JavaScript / TSX node types that represent symbols. */
const TS_SYMBOL_NODES: Record<string, SymbolKind> = {
  function_declaration:          'function',
  generator_function_declaration:'function',
  arrow_function:                'function',
  method_definition:             'method',
  class_declaration:             'class',
  abstract_class_declaration:    'class',
  interface_declaration:         'interface',
  enum_declaration:              'enum',
  type_alias_declaration:        'type',
  module:                        'module',
  // variable declarations handled separately (lexical_declaration / variable_declaration)
};

const PY_SYMBOL_NODES: Record<string, SymbolKind> = {
  function_definition:           'function',
  class_definition:              'class',
};

const GO_SYMBOL_NODES: Record<string, SymbolKind> = {
  function_declaration:          'function',
  method_declaration:            'method',
  type_declaration:              'type',
};

const RUST_SYMBOL_NODES: Record<string, SymbolKind> = {
  function_item:                 'function',
  impl_item:                     'class',
  struct_item:                   'class',
  enum_item:                     'enum',
  trait_item:                    'interface',
  type_item:                     'type',
  mod_item:                      'module',
};

const JAVA_SYMBOL_NODES: Record<string, SymbolKind> = {
  method_declaration:            'method',
  constructor_declaration:       'method',
  class_declaration:             'class',
  interface_declaration:         'interface',
  enum_declaration:              'enum',
  record_declaration:            'class',
  annotation_type_declaration:   'interface',
};

const CSHARP_SYMBOL_NODES: Record<string, SymbolKind> = {
  method_declaration:            'method',
  constructor_declaration:       'method',
  class_declaration:             'class',
  interface_declaration:         'interface',
  enum_declaration:              'enum',
  struct_declaration:            'class',
  record_declaration:            'class',
  namespace_declaration:         'namespace',
};

const KOTLIN_SYMBOL_NODES: Record<string, SymbolKind> = {
  function_declaration:          'function',
  class_declaration:             'class',
  object_declaration:            'class',
  interface_declaration:         'interface',
};

const RUBY_SYMBOL_NODES: Record<string, SymbolKind> = {
  method:                        'method',
  singleton_method:              'method',
  class:                         'class',
  module:                        'module',
};

const CPP_SYMBOL_NODES: Record<string, SymbolKind> = {
  function_definition:           'function',
  class_specifier:               'class',
  struct_specifier:              'class',
  enum_specifier:                'enum',
  namespace_definition:          'namespace',
};

const PHP_SYMBOL_NODES: Record<string, SymbolKind> = {
  function_definition:           'function',
  method_declaration:            'method',
  class_declaration:             'class',
  interface_declaration:         'interface',
  trait_declaration:             'class',
  enum_declaration:              'enum',
};

const SWIFT_SYMBOL_NODES: Record<string, SymbolKind> = {
  function_declaration:          'function',
  class_declaration:             'class',
  struct_declaration:            'class',
  enum_declaration:              'enum',
  protocol_declaration:          'interface',
};

/**
 * CSS family (also reused for SCSS/Sass/Less/Stylus via the CSS wasm).
 * Each rule_set is a "class" symbol whose name is the selector text;
 * at-rules (mixins, keyframes, media queries) become "function"-kind
 * entries so the skeleton groups them visibly. SCSS-only constructs
 * (parent `&`, nested rules, `@mixin`) appear inside ERROR nodes but
 * top-level rule_sets keep parsing — error-tolerance is the point here.
 */
const CSS_SYMBOL_NODES: Record<string, SymbolKind> = {
  rule_set:           'class',
  at_rule:            'function',
  keyframes_statement:'function',
};

/**
 * HTML / Vue / Svelte. Most `element` nodes are noise (every <div> is one),
 * so getSymbolName filters down to elements with `id=...` or named/custom
 * tags worth surfacing. Top-level <script> and <style> blocks always
 * appear as separate symbols so the agent sees the file's structure.
 */
const HTML_SYMBOL_NODES: Record<string, SymbolKind> = {
  element:            'class',
  script_element:     'function',
  style_element:      'function',
};

function getSymbolNodesForLanguage(lang: string): Record<string, SymbolKind> {
  switch (lang) {
    case 'typescript': case 'tsx': case 'javascript': return TS_SYMBOL_NODES;
    case 'python':    return PY_SYMBOL_NODES;
    case 'go':        return GO_SYMBOL_NODES;
    case 'rust':      return RUST_SYMBOL_NODES;
    case 'java':      return JAVA_SYMBOL_NODES;
    case 'csharp':    return CSHARP_SYMBOL_NODES;
    case 'kotlin':    return KOTLIN_SYMBOL_NODES;
    case 'ruby':      return RUBY_SYMBOL_NODES;
    case 'cpp': case 'c': return CPP_SYMBOL_NODES;
    case 'php':       return PHP_SYMBOL_NODES;
    case 'swift':     return SWIFT_SYMBOL_NODES;
    case 'css':       return CSS_SYMBOL_NODES;
    case 'html': case 'vue': return HTML_SYMBOL_NODES;
    default:          return {};
  }
}

/** Import node types per language family. */
const IMPORT_NODES: Record<string, string[]> = {
  typescript: ['import_statement', 'import_clause', 'export_statement'],
  tsx:        ['import_statement', 'import_clause', 'export_statement'],
  javascript: ['import_statement', 'import_clause', 'export_statement'],
  python:     ['import_statement', 'import_from_statement'],
  go:         ['import_declaration'],
  rust:       ['use_declaration', 'extern_crate_declaration'],
  java:       ['import_declaration'],
  csharp:     ['using_directive'],
  kotlin:     ['import_header'],
  ruby:       ['call'],  // require/require_relative
  cpp:        ['preproc_include'],
  c:          ['preproc_include'],
  php:        ['namespace_use_declaration'],
  swift:      ['import_declaration'],
};

// ─── Main Extractor ──────────────────────────────────────────────

export class TreeSitterExtractor {
  private parsers = new Map<string, Parser>();

  /**
   * Extract structural information from a source file.
   * Returns { supported: false } if the file extension isn't recognized,
   * allowing the caller to fall back to LLM analysis.
   */
  async extract(filePath: string, content: string): Promise<TreeSitterResult> {
    const ext = extname(filePath).replace(/^\./, '').toLowerCase();
    const grammarInfo = getGrammarForExtension(ext);

    if (!grammarInfo) {
      return { supported: false, language: ext, analysis: {} };
    }

    const { wasmFile, language } = grammarInfo;

    if (!isExtractable(language)) {
      return {
        supported: false,
        language,
        analysis: { language },
      };
    }

    const parser = await this.getParser(wasmFile);
    const tree = parser.parse(content);

    try {
      const symbols = this.extractSymbols(tree.rootNode, language, content);
      const { internalDeps, externalDeps, allDeps, references } =
        this.extractImportsAndRefs(tree.rootNode, language, content, filePath);

      // Call-graph: capture call sites whose callee is a name we know in this
      // file (locally defined or imported). Merged into the import references
      // so they flow through the same `symbol_references` persistence path.
      const knownNames = new Set<string>();
      for (const s of symbols) knownNames.add(s.name);
      for (const r of references) knownNames.add(r.symbol_name);
      const callRefs = extractCalls(tree.rootNode, language, knownNames);

      const analysis: Partial<LLMFileAnalysis> = {
        language,
        symbols,
        references: references.concat(callRefs),
        dependencies: allDeps,
        internal_deps: internalDeps,
        external_deps: externalDeps,
        // Fields that still need LLM:
        // summary, concepts, notes, complexity, layer, is_entry_point, is_test, is_generated
      };

      return { supported: true, language, analysis };
    } finally {
      tree.delete();
    }
  }

  /** Release all parser instances. */
  dispose(): void {
    for (const parser of this.parsers.values()) {
      parser.delete();
    }
    this.parsers.clear();
  }

  // ─── Private ─────────────────────────────────────────────────

  private async getParser(wasmFile: string): Promise<Parser> {
    const cached = this.parsers.get(wasmFile);
    if (cached) return cached;
    const parser = await createParser(wasmFile);
    this.parsers.set(wasmFile, parser);
    return parser;
  }

  /**
   * Walk the AST to extract symbols.
   * Uses the language-specific node type map to identify symbol definitions.
   */
  private extractSymbols(
    rootNode: Parser.SyntaxNode,
    language: string,
    content: string
  ): LLMSymbol[] {
    const symbolNodes = getSymbolNodesForLanguage(language);
    const symbols: LLMSymbol[] = [];
    const lines = content.split('\n');

    // Track nesting depth to skip inline arrow functions and local constants
    const walk = (node: Parser.SyntaxNode, parentName: string | null, depth: number) => {
      const kind = symbolNodes[node.type];

      if (kind) {
        // Skip arrow functions that are nested inside expressions (callbacks, .find(), .map(), etc.)
        // Only capture arrow_function if it's assigned to a variable at top/class level
        if (node.type === 'arrow_function' && depth > 0) {
          return; // Skip inline/callback arrow functions
        }

        const sym = this.buildSymbol(node, kind, language, parentName, lines);
        if (sym) {
          symbols.push(sym);
          // Recurse into class/interface bodies for nested symbols
          if (kind === 'class' || kind === 'interface' || kind === 'module' || kind === 'namespace') {
            for (const child of node.namedChildren) {
              walk(child, sym.name, 1);
            }
            return; // Don't double-walk children
          }
          // Don't recurse deeper into function/method bodies for symbol extraction
          return;
        }
      }

      // Handle variable/constant declarations (TS/JS) — only at top level or class body level
      if (depth <= 1 && this.isConstantDeclaration(node, language)) {
        const sym = this.buildConstant(node, language, parentName, lines);
        if (sym) symbols.push(sym);
        return; // Don't recurse into const value
      }

      // Recurse into children for top-level exploration
      for (const child of node.namedChildren) {
        walk(child, parentName, depth);
      }
    };

    walk(rootNode, null, 0);
    return symbols;
  }

  /** Build an LLMSymbol from an AST node. */
  private buildSymbol(
    node: Parser.SyntaxNode,
    kind: SymbolKind,
    language: string,
    parentName: string | null,
    lines: string[]
  ): LLMSymbol | null {
    const name = this.getSymbolName(node, language);
    if (!name) return null;

    const line = node.startPosition.row + 1; // 1-indexed
    const endLine = node.endPosition.row + 1;
    const col = node.startPosition.column + 1; // 1-based, Monaco-compatible
    const modifiers = this.getModifiers(node, language);
    const signature = this.buildSignature(node, kind, name, language);
    const params = this.getParameters(node, language);
    const returnType = this.getReturnType(node, language);
    const extendsFrom = this.getExtends(node, language);
    const implementsList = this.getImplements(node, language);
    const comment = this.getLeadingComment(node, lines);
    const tags = this.inferTags(name, kind, modifiers, node, language);

    return {
      name,
      kind,
      signature,
      parent: parentName,
      extends_from: extendsFrom || undefined,
      implements_list: implementsList.length > 0 ? implementsList : undefined,
      modifiers,
      return_type: returnType,
      parameters: params,
      line,
      end_line: endLine,
      col,
      exported: this.computeExported(language, modifiers, parentName, name),
      comment,
      tags,
    } as LLMSymbol & { end_line: number };
  }

  /**
   * Per-language visibility — honest semantics, biased toward INCLUDE when a
   * language has no explicit export concept (better to over-offer in
   * completion than hide real API surface).
   */
  private computeExported(
    language: string,
    modifiers: string[],
    parent: string | null,
    name: string,
  ): boolean {
    switch (language) {
      case 'typescript':
      case 'tsx':
      case 'javascript':
        return modifiers.includes('export') || modifiers.includes('default');
      case 'python':
        return parent === null && !name.startsWith('_');
      case 'go':
        return /^[A-Z]/.test(name); // the language rule itself
      case 'rust':
        // Covers `pub`, `pub(crate)`, `pub(super)` and the legacy 'export' tag.
        return modifiers.some((m) => m.startsWith('pub')) || modifiers.includes('export');
      case 'php':
        // PHP members default to public; only explicit private/protected hide.
        return parent === null
          ? true
          : !modifiers.includes('private') && !modifiers.includes('protected');
      case 'java':
      case 'csharp':
      case 'kotlin':
      case 'swift':
        return modifiers.includes('public') || modifiers.includes('open');
      case 'css':
      case 'html':
      case 'vue':
        return false;
      default:
        return parent === null;
    }
  }

  /** Extract symbol name from node based on language conventions. */
  private getSymbolName(node: Parser.SyntaxNode, language: string): string | null {
    // CSS family — symbol name comes from the selector text or the at-rule name.
    if (language === 'css') {
      if (node.type === 'rule_set') {
        const selectors = node.namedChildren.find((c) => c.type === 'selectors');
        const text = (selectors ?? node.firstNamedChild)?.text ?? '';
        const trimmed = text.split('\n')[0]?.trim() ?? '';
        if (!trimmed) return null;
        return trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed;
      }
      if (node.type === 'at_rule' || node.type === 'keyframes_statement') {
        // Examples: "@mixin name(args)", "@keyframes spin", "@media (max-width: 600px)".
        // First line minus leading whitespace, capped.
        const first = node.text.split('\n')[0]?.trim() ?? '';
        if (!first) return null;
        // Strip trailing "{" or ";" so "@mixin foo { … }" reads "@mixin foo".
        const cleaned = first.replace(/\s*\{$/, '').replace(/;\s*$/, '');
        return cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned;
      }
    }

    // HTML / Vue / Svelte — prefer id="...", fall back to a custom/named tag.
    // Generic <div>/<span> with no id are filtered out (return null) to avoid
    // dumping every node in a template into the skeleton.
    if (language === 'html' || language === 'vue') {
      if (node.type === 'script_element') return '<script>';
      if (node.type === 'style_element') return '<style>';
      if (node.type === 'element') {
        const startTag = node.namedChildren.find((c) => c.type === 'start_tag' || c.type === 'self_closing_tag');
        if (!startTag) return null;
        const tagNameNode = startTag.namedChildren.find((c) => c.type === 'tag_name');
        const tagName = tagNameNode?.text ?? '';
        // Look for id="..." attribute
        let idValue: string | null = null;
        for (const attr of startTag.namedChildren.filter((c) => c.type === 'attribute')) {
          const an = attr.namedChildren.find((c) => c.type === 'attribute_name');
          if (an?.text === 'id') {
            const av = attr.namedChildren.find((c) => c.type === 'quoted_attribute_value' || c.type === 'attribute_value');
            const inner = av?.namedChildren.find((c) => c.type === 'attribute_value');
            idValue = (inner ?? av)?.text?.replace(/^["']|["']$/g, '') ?? null;
            break;
          }
        }
        if (idValue) return `${tagName}#${idValue}`;
        // Surface only custom/named elements (with hyphen — Web Components,
        // Angular components, Vue components) and known structural tags.
        const STRUCTURAL = new Set(['header', 'main', 'footer', 'nav', 'section', 'article', 'aside', 'form', 'router-outlet']);
        if (tagName.includes('-') || STRUCTURAL.has(tagName)) return `<${tagName}>`;
        return null; // <div>, <span>, etc. without id — skip
      }
    }

    // Most languages use a 'name' field
    const nameNode = node.childForFieldName('name');
    if (nameNode) return nameNode.text;

    // Some languages use 'declarator' (C/C++)
    const declNode = node.childForFieldName('declarator');
    if (declNode) {
      const innerName = declNode.childForFieldName('name');
      return innerName?.text ?? declNode.text.split('(')[0]?.trim() ?? null;
    }

    // Fallback: first named child with identifier-like type
    for (const child of node.namedChildren) {
      if (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'name') {
        return child.text;
      }
    }

    return null;
  }

  /** Get modifier keywords (export, async, static, public, etc.). */
  private getModifiers(node: Parser.SyntaxNode, language: string): string[] {
    const mods: string[] = [];

    // Check parent for export_statement (TS/JS)
    if (['typescript', 'tsx', 'javascript'].includes(language)) {
      if (node.parent?.type === 'export_statement') {
        mods.push('export');
        if (node.parent.children.some(c => c.type === 'default')) {
          mods.push('default');
        }
      }
    }

    // Walk children for modifier keywords
    for (const child of node.children) {
      if (!child.isNamed && this.isModifierKeyword(child.type, language)) {
        mods.push(child.type);
      }
      // Some languages use modifier nodes
      if (child.type === 'modifiers' || child.type === 'modifier') {
        mods.push(...child.text.split(/\s+/).filter(Boolean));
      }
      // Shared node type with per-language TEXT: Rust `pub`/`pub(crate)`,
      // PHP `private`/`protected`/`public` — push the actual keyword.
      if (child.type === 'visibility_modifier') mods.push(child.text.trim());
      // TS/JS: async keyword
      if (child.type === 'async') mods.push('async');
    }

    // Check node text for common patterns
    const firstLine = node.text.split('\n')[0] ?? '';
    if (['typescript', 'tsx', 'javascript'].includes(language)) {
      if (firstLine.includes('abstract ')) mods.push('abstract');
    }

    return [...new Set(mods)];
  }

  private isModifierKeyword(type: string, language: string): boolean {
    const modKeywords: Record<string, Set<string>> = {
      java: new Set(['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native', 'default']),
      csharp: new Set(['public', 'private', 'protected', 'internal', 'static', 'abstract', 'virtual', 'override', 'sealed', 'async', 'readonly']),
      kotlin: new Set(['public', 'private', 'protected', 'internal', 'open', 'abstract', 'override', 'suspend', 'inline', 'data', 'sealed']),
      swift: new Set(['public', 'private', 'internal', 'open', 'static', 'class', 'override', 'final', 'mutating', 'async']),
    };
    return modKeywords[language]?.has(type) ?? false;
  }

  /** Build a human-readable signature for the symbol. */
  private buildSignature(
    node: Parser.SyntaxNode,
    kind: SymbolKind,
    name: string,
    language: string
  ): string {
    // For functions/methods, extract up to first '{' or ':'
    if (kind === 'function' || kind === 'method') {
      const firstLine = node.text.split('\n')[0] ?? '';
      // Trim body start
      const sig = firstLine
        .replace(/\{.*$/, '')
        .replace(/:\s*$/, '')
        .trim();
      return sig.length > 200 ? sig.slice(0, 200) + '...' : sig;
    }

    // For classes/interfaces, extract the declaration line
    if (kind === 'class' || kind === 'interface') {
      const firstLine = node.text.split('\n')[0] ?? '';
      return firstLine.replace(/\{.*$/, '').trim().slice(0, 200);
    }

    // For types/enums, use first line
    const firstLine = node.text.split('\n')[0] ?? '';
    return firstLine.replace(/[{=].*$/, '').trim().slice(0, 200);
  }

  /** Extract parameter list as a string. */
  private getParameters(node: Parser.SyntaxNode, language: string): string | null {
    // Look for formal_parameters, parameters, parameter_list fields
    const paramFields = ['parameters', 'formal_parameters', 'parameter_list'];
    for (const field of paramFields) {
      const paramNode = node.childForFieldName(field);
      if (paramNode) {
        // Strip outer parens
        const text = paramNode.text.replace(/^\(/, '').replace(/\)$/, '').trim();
        return text || null;
      }
    }

    // Fallback: look for child node types
    for (const child of node.namedChildren) {
      if (['formal_parameters', 'parameters', 'parameter_list', 'function_parameters'].includes(child.type)) {
        const text = child.text.replace(/^\(/, '').replace(/\)$/, '').trim();
        return text || null;
      }
    }

    return null;
  }

  /** Extract return type annotation. */
  private getReturnType(node: Parser.SyntaxNode, language: string): string | null {
    // TS/JS: type_annotation or return_type field
    const retNode = node.childForFieldName('return_type')
      ?? node.childForFieldName('type');
    if (retNode) {
      return retNode.text.replace(/^:\s*/, '').trim();
    }

    // Look for type_annotation child
    for (const child of node.namedChildren) {
      if (child.type === 'type_annotation' && child.previousNamedSibling?.type !== 'identifier') {
        return child.text.replace(/^:\s*/, '').trim();
      }
    }

    // Go: result field
    const result = node.childForFieldName('result');
    if (result) return result.text;

    // Rust: return_type field
    const rustRet = node.childForFieldName('return_type');
    if (rustRet) return rustRet.text.replace(/^->\s*/, '').trim();

    return null;
  }

  /** Get extends clause for classes. */
  private getExtends(node: Parser.SyntaxNode, language: string): string | null {
    // TS/JS: class_heritage / extends_clause
    for (const child of node.namedChildren) {
      if (child.type === 'class_heritage' || child.type === 'extends_clause'
          || child.type === 'superclass') {
        // Extract the class name from the clause
        const typeNode = child.namedChildren.find(c =>
          c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'generic_type'
        );
        return typeNode?.text ?? child.text.replace(/^extends\s+/, '').trim();
      }
    }

    // Java/Kotlin: superclass
    const superNode = node.childForFieldName('superclass');
    if (superNode) return superNode.text;

    // Rust impl: trait
    if (node.type === 'impl_item') {
      const traitNode = node.childForFieldName('trait');
      if (traitNode) return traitNode.text;
    }

    return null;
  }

  /** Get implements clause for classes. */
  private getImplements(node: Parser.SyntaxNode, language: string): string[] {
    const impls: string[] = [];

    for (const child of node.namedChildren) {
      if (child.type === 'implements_clause' || child.type === 'class_heritage') {
        // Extract interface names
        for (const typeNode of child.namedChildren) {
          if (typeNode.type === 'type_identifier' || typeNode.type === 'identifier'
              || typeNode.type === 'generic_type') {
            impls.push(typeNode.text);
          }
        }
      }
    }

    // Java: interfaces field
    const ifaces = node.childForFieldName('interfaces');
    if (ifaces) {
      for (const child of ifaces.namedChildren) {
        if (child.type === 'type_identifier' || child.type === 'type_list') {
          impls.push(child.text);
        }
      }
    }

    return impls;
  }

  /** Get the comment immediately preceding a node. */
  private getLeadingComment(node: Parser.SyntaxNode, lines: string[]): string | null {
    // Look at previous sibling for comment nodes
    let prev = node.previousNamedSibling;
    if (!prev) {
      // Check for non-named comment siblings
      prev = node.previousSibling;
    }

    if (prev && (prev.type === 'comment' || prev.type === 'line_comment'
        || prev.type === 'block_comment' || prev.type === 'doc_comment')) {
      const text = prev.text
        .replace(/^\/\*\*?\s*/, '')
        .replace(/\*\/\s*$/, '')
        .replace(/^\/\/\s*/gm, '')
        .replace(/^\s*\*\s?/gm, '')
        .trim();
      // Take first 2 lines as comment
      const twoLines = text.split('\n').slice(0, 2).join(' ').trim();
      return twoLines.length > 200 ? twoLines.slice(0, 200) + '...' : twoLines || null;
    }

    // Check line before node for inline comment
    const prevLineIdx = node.startPosition.row - 1;
    if (prevLineIdx >= 0 && prevLineIdx < lines.length) {
      const prevLine = lines[prevLineIdx].trim();
      if (prevLine.startsWith('//') || prevLine.startsWith('#')) {
        return prevLine.replace(/^\/\/\s*/, '').replace(/^#\s*/, '').trim() || null;
      }
    }

    return null;
  }

  /** Infer tags based on naming conventions and context. */
  private inferTags(
    name: string,
    kind: SymbolKind,
    modifiers: string[],
    node: Parser.SyntaxNode,
    language: string
  ): string[] {
    const tags: string[] = [];
    const lower = name.toLowerCase();

    if (modifiers.includes('export') || modifiers.includes('public')) tags.push('exported');
    if (modifiers.includes('async') || modifiers.includes('suspend')) tags.push('async');
    if (modifiers.includes('static')) tags.push('static');
    if (modifiers.includes('abstract')) tags.push('abstract');

    // Naming convention tags
    if (/^(test_|test|it|describe|spec)/.test(lower) || /\.(test|spec)\.(ts|js|py)$/.test(lower)) {
      tags.push('test');
    }
    if (/^(handle|on[A-Z])/.test(name)) tags.push('handler');
    if (/^(get|fetch|load|read)/.test(name)) tags.push('getter');
    if (/^(set|save|write|update|create|delete|remove)/.test(name)) tags.push('mutator');
    if (/^(is|has|can|should|check|validate)/.test(name)) tags.push('predicate');
    if (/middleware|interceptor/i.test(name)) tags.push('middleware');
    if (/route|controller|handler|endpoint/i.test(name)) tags.push('route');
    if (/hook|use[A-Z]/.test(name)) tags.push('hook');
    if (/util|helper|format|parse|convert|transform/i.test(name)) tags.push('utility');
    if (lower === 'main' || lower === 'index' || lower === 'app' || lower === 'server') {
      tags.push('entry-point');
    }

    return [...new Set(tags)];
  }

  /** Check if a node represents a constant/variable declaration. */
  private isConstantDeclaration(node: Parser.SyntaxNode, language: string): boolean {
    if (['typescript', 'tsx', 'javascript'].includes(language)) {
      return node.type === 'lexical_declaration' || node.type === 'variable_declaration';
    }
    if (language === 'go') {
      return node.type === 'const_declaration' || node.type === 'var_declaration';
    }
    if (language === 'rust') {
      return node.type === 'const_item' || node.type === 'static_item';
    }
    if (language === 'python') {
      // Python top-level assignments with UPPER_CASE names
      return node.type === 'expression_statement'
        && node.namedChildren[0]?.type === 'assignment';
    }
    return false;
  }

  /** Build an LLMSymbol for a constant/variable declaration. */
  private buildConstant(
    node: Parser.SyntaxNode,
    language: string,
    parentName: string | null,
    lines: string[]
  ): LLMSymbol | null {
    if (['typescript', 'tsx', 'javascript'].includes(language)) {
      return this.buildTsConstant(node, parentName, lines);
    }
    if (language === 'go') {
      return this.buildGoConstant(node, parentName, lines);
    }
    if (language === 'rust') {
      return this.buildRustConstant(node, parentName, lines);
    }
    if (language === 'python') {
      return this.buildPyConstant(node, parentName, lines);
    }
    return null;
  }

  private buildTsConstant(node: Parser.SyntaxNode, parentName: string | null, lines: string[]): LLMSymbol | null {
    // lexical_declaration → variable_declarator → name + value
    const declarator = node.namedChildren.find(c => c.type === 'variable_declarator');
    if (!declarator) return null;

    const nameNode = declarator.childForFieldName('name');
    if (!nameNode) return null;
    const name = nameNode.text;

    // Skip non-exported or small declarations inside functions
    if (parentName !== null) return null;

    // Determine if this is an arrow function assigned to a const
    const value = declarator.childForFieldName('value');
    if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
      const params = this.getParameters(value, 'typescript');
      const returnType = this.getReturnType(value, 'typescript');
      const modifiers = this.getModifiers(node, 'typescript');
      return {
        name,
        kind: 'function',
        signature: node.text.split('\n')[0]?.replace(/\{.*$/, '').trim().slice(0, 200) ?? name,
        parent: parentName,
        modifiers,
        return_type: returnType,
        parameters: params,
        line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        col: node.startPosition.column + 1,
        exported: this.computeExported('typescript', modifiers, parentName, name),
        comment: this.getLeadingComment(node, lines),
        tags: this.inferTags(name, 'function', modifiers, node, 'typescript'),
      } as LLMSymbol & { end_line: number };
    }

    // Regular constant
    const isConst = node.text.startsWith('const ');
    const kind: SymbolKind = isConst ? 'constant' : 'variable';
    const modifiers = this.getModifiers(node, 'typescript');

    return {
      name,
      kind,
      signature: node.text.split('\n')[0]?.trim().slice(0, 200) ?? name,
      parent: parentName,
      modifiers,
      return_type: null,
      parameters: null,
      line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      col: node.startPosition.column + 1,
      exported: this.computeExported('typescript', modifiers, parentName, name),
      comment: this.getLeadingComment(node, lines),
      tags: this.inferTags(name, kind, modifiers, node, 'typescript'),
    } as LLMSymbol & { end_line: number };
  }

  private buildGoConstant(node: Parser.SyntaxNode, parentName: string | null, lines: string[]): LLMSymbol | null {
    const spec = node.namedChildren.find(c => c.type === 'const_spec' || c.type === 'var_spec');
    if (!spec) return null;
    const nameNode = spec.childForFieldName('name');
    if (!nameNode) return null;
    const name = nameNode.text;
    const kind: SymbolKind = node.type === 'const_declaration' ? 'constant' : 'variable';
    return {
      name, kind,
      signature: node.text.split('\n')[0]?.trim().slice(0, 200) ?? name,
      parent: parentName,
      modifiers: name[0] === name[0].toUpperCase() ? ['export'] : [],
      return_type: null, parameters: null,
      line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      col: node.startPosition.column + 1,
      exported: this.computeExported('go', [], parentName, name),
      comment: this.getLeadingComment(node, lines),
      tags: [],
    } as LLMSymbol & { end_line: number };
  }

  private buildRustConstant(node: Parser.SyntaxNode, parentName: string | null, lines: string[]): LLMSymbol | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;
    const name = nameNode.text;
    const kind: SymbolKind = node.type === 'const_item' ? 'constant' : 'variable';
    const modifiers: string[] = [];
    if (node.children.some(c => c.type === 'pub' || c.type === 'visibility_modifier')) modifiers.push('pub');
    return {
      name, kind,
      signature: node.text.split('\n')[0]?.trim().slice(0, 200) ?? name,
      parent: parentName, modifiers,
      return_type: null, parameters: null,
      line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      col: node.startPosition.column + 1,
      exported: this.computeExported('rust', modifiers, parentName, name),
      comment: this.getLeadingComment(node, lines),
      tags: [],
    } as LLMSymbol & { end_line: number };
  }

  private buildPyConstant(node: Parser.SyntaxNode, parentName: string | null, lines: string[]): LLMSymbol | null {
    const assign = node.namedChildren[0];
    if (!assign || assign.type !== 'assignment') return null;
    const left = assign.childForFieldName('left');
    if (!left || left.type !== 'identifier') return null;
    const name = left.text;
    // Only capture UPPER_CASE or __dunder__ constants at module level
    if (parentName !== null && !/^[A-Z_][A-Z0-9_]*$/.test(name) && !/^__\w+__$/.test(name)) return null;
    return {
      name, kind: 'constant',
      signature: node.text.split('\n')[0]?.trim().slice(0, 200) ?? name,
      parent: parentName, modifiers: [],
      return_type: null, parameters: null,
      line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      col: node.startPosition.column + 1,
      exported: this.computeExported('python', [], parentName, name),
      comment: this.getLeadingComment(node, lines),
      tags: [],
    } as LLMSymbol & { end_line: number };
  }

  // ─── Import / Dependency extraction ─────────────────────────

  private extractImportsAndRefs(
    rootNode: Parser.SyntaxNode,
    language: string,
    content: string,
    filePath: string
  ): {
    internalDeps: string[];
    externalDeps: string[];
    allDeps: string[];
    references: LLMReference[];
  } {
    const importNodeTypes = IMPORT_NODES[language] ?? [];
    const internalDeps: string[] = [];
    const externalDeps: string[] = [];
    const allDeps: string[] = [];
    const references: LLMReference[] = [];
    const seen = new Set<string>();

    const walk = (node: Parser.SyntaxNode) => {
      if (importNodeTypes.includes(node.type)) {
        const importInfo = this.parseImportNode(node, language);
        if (importInfo && !seen.has(importInfo.modulePath)) {
          seen.add(importInfo.modulePath);
          allDeps.push(importInfo.modulePath);

          if (importInfo.isInternal) {
            internalDeps.push(importInfo.modulePath);
          } else {
            externalDeps.push(importInfo.modulePath);
          }

          // Build references for named imports
          for (const name of importInfo.importedNames) {
            references.push({
              symbol_name: name,
              kind: 'other' as SymbolKind,
              line: node.startPosition.row + 1,
              col: node.startPosition.column + 1,
              snippet: node.text.split('\n')[0]?.trim().slice(0, 120),
            });
          }
        }
      }

      for (const child of node.namedChildren) {
        walk(child);
      }
    };

    walk(rootNode);
    return { internalDeps, externalDeps, allDeps, references };
  }

  /** Parse an import/require node to extract module path and imported names. */
  private parseImportNode(
    node: Parser.SyntaxNode,
    language: string
  ): { modulePath: string; isInternal: boolean; importedNames: string[] } | null {
    if (['typescript', 'tsx', 'javascript'].includes(language)) {
      return this.parseTsImport(node);
    }
    if (language === 'python') {
      return this.parsePyImport(node);
    }
    if (language === 'go') {
      return this.parseGoImport(node);
    }
    if (language === 'java' || language === 'kotlin') {
      return this.parseJavaImport(node);
    }
    if (language === 'rust') {
      return this.parseRustImport(node);
    }
    if (language === 'csharp') {
      return this.parseCsharpImport(node);
    }
    if (language === 'cpp' || language === 'c') {
      return this.parseCppImport(node);
    }
    if (language === 'php') {
      return this.parsePhpImport(node);
    }
    if (language === 'ruby') {
      return this.parseRubyImport(node);
    }
    if (language === 'swift') {
      return this.parseSwiftImport(node);
    }
    return null;
  }

  private parseTsImport(node: Parser.SyntaxNode): { modulePath: string; isInternal: boolean; importedNames: string[] } | null {
    // Find string literal with the module path
    const source = node.childForFieldName('source')
      ?? node.namedChildren.find(c => c.type === 'string' || c.type === 'string_literal');
    if (!source) return null;

    const modulePath = source.text.replace(/['"]/g, '');
    const isInternal = modulePath.startsWith('.') || modulePath.startsWith('/');

    const importedNames: string[] = [];

    // Named imports: import { foo, bar } from '...'
    for (const child of node.descendantsOfType('import_specifier')) {
      const name = child.childForFieldName('name')?.text ?? child.text;
      importedNames.push(name);
    }

    // Default import: import Foo from '...'
    const defaultImport = node.namedChildren.find(c => c.type === 'identifier');
    if (defaultImport && !importedNames.includes(defaultImport.text)) {
      importedNames.push(defaultImport.text);
    }

    // Namespace import: import * as ns from '...'
    const nsImport = node.namedChildren.find(c => c.type === 'namespace_import');
    if (nsImport) {
      const alias = nsImport.childForFieldName('name')?.text ?? nsImport.text.replace(/^\*\s*as\s+/, '');
      importedNames.push(alias);
    }

    return { modulePath, isInternal, importedNames };
  }

  private parsePyImport(node: Parser.SyntaxNode): { modulePath: string; isInternal: boolean; importedNames: string[] } | null {
    if (node.type === 'import_statement') {
      const nameNode = node.namedChildren.find(c => c.type === 'dotted_name' || c.type === 'aliased_import');
      if (!nameNode) return null;
      const modulePath = nameNode.type === 'aliased_import'
        ? nameNode.namedChildren[0]?.text ?? nameNode.text
        : nameNode.text;
      return { modulePath, isInternal: modulePath.startsWith('.'), importedNames: [modulePath.split('.').pop() ?? modulePath] };
    }

    if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name')
        ?? node.namedChildren.find(c => c.type === 'dotted_name' || c.type === 'relative_import');
      const modulePath = moduleNode?.text ?? '';
      const importedNames: string[] = [];
      for (const child of node.namedChildren) {
        if (child.type === 'dotted_name' && child !== moduleNode) {
          importedNames.push(child.text);
        }
        if (child.type === 'aliased_import') {
          importedNames.push(child.namedChildren[0]?.text ?? child.text);
        }
      }
      return { modulePath, isInternal: modulePath.startsWith('.'), importedNames };
    }

    return null;
  }

  private parseGoImport(node: Parser.SyntaxNode): { modulePath: string; isInternal: boolean; importedNames: string[] } | null {
    const specs = node.descendantsOfType('import_spec');
    if (specs.length === 0) {
      // Single import: import "fmt"
      const pathNode = node.namedChildren.find(c => c.type === 'interpreted_string_literal');
      if (!pathNode) return null;
      const modulePath = pathNode.text.replace(/"/g, '');
      const pkgName = modulePath.split('/').pop() ?? modulePath;
      return { modulePath, isInternal: !modulePath.includes('.'), importedNames: [pkgName] };
    }

    // Grouped imports — take first for simplicity (indexer calls per-file)
    const first = specs[0];
    const pathNode = first.namedChildren.find(c => c.type === 'interpreted_string_literal');
    if (!pathNode) return null;
    const modulePath = pathNode.text.replace(/"/g, '');
    const pkgName = modulePath.split('/').pop() ?? modulePath;
    return { modulePath, isInternal: !modulePath.includes('.'), importedNames: [pkgName] };
  }

  private parseJavaImport(node: Parser.SyntaxNode): { modulePath: string; isInternal: boolean; importedNames: string[] } | null {
    // import com.example.Foo;
    const text = node.text.replace(/^import\s+(static\s+)?/, '').replace(/;\s*$/, '').trim();
    const parts = text.split('.');
    const name = parts.pop() ?? text;
    return { modulePath: text, isInternal: false, importedNames: name === '*' ? [] : [name] };
  }

  private parseRustImport(node: Parser.SyntaxNode): { modulePath: string; isInternal: boolean; importedNames: string[] } | null {
    const text = node.text.replace(/^(use|extern\s+crate)\s+/, '').replace(/;\s*$/, '').trim();
    const modulePath = text.split('::').slice(0, -1).join('::') || text;
    const lastPart = text.split('::').pop() ?? text;
    const isInternal = text.startsWith('crate::') || text.startsWith('self::') || text.startsWith('super::');
    return { modulePath, isInternal, importedNames: [lastPart.replace(/[{}]/g, '')] };
  }

  private parseCsharpImport(node: Parser.SyntaxNode): { modulePath: string; isInternal: boolean; importedNames: string[] } | null {
    const text = node.text.replace(/^using\s+(static\s+)?/, '').replace(/;\s*$/, '').trim();
    const parts = text.split('.');
    const name = parts.pop() ?? text;
    return { modulePath: text, isInternal: false, importedNames: [name] };
  }

  private parseCppImport(node: Parser.SyntaxNode): { modulePath: string; isInternal: boolean; importedNames: string[] } | null {
    const pathNode = node.childForFieldName('path');
    if (!pathNode) return null;
    const modulePath = pathNode.text.replace(/[<>"]/g, '');
    const isInternal = pathNode.text.startsWith('"');
    return { modulePath, isInternal, importedNames: [] };
  }

  private parsePhpImport(node: Parser.SyntaxNode): { modulePath: string; isInternal: boolean; importedNames: string[] } | null {
    const text = node.text.replace(/^use\s+/, '').replace(/;\s*$/, '').trim();
    const parts = text.split('\\');
    const name = parts.pop() ?? text;
    return { modulePath: text, isInternal: false, importedNames: [name] };
  }

  private parseRubyImport(node: Parser.SyntaxNode): { modulePath: string; isInternal: boolean; importedNames: string[] } | null {
    // Ruby: require 'foo' or require_relative 'bar'
    if (node.type !== 'call') return null;
    const method = node.childForFieldName('method')?.text;
    if (method !== 'require' && method !== 'require_relative') return null;
    const args = node.childForFieldName('arguments');
    const strNode = args?.namedChildren.find(c => c.type === 'string' || c.type === 'string_literal');
    if (!strNode) return null;
    const modulePath = strNode.text.replace(/['"]/g, '');
    return { modulePath, isInternal: method === 'require_relative', importedNames: [] };
  }

  private parseSwiftImport(node: Parser.SyntaxNode): { modulePath: string; isInternal: boolean; importedNames: string[] } | null {
    const text = node.text.replace(/^import\s+/, '').trim();
    return { modulePath: text, isInternal: false, importedNames: [text] };
  }
}
