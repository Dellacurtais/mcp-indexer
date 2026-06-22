/**
 * Tree-sitter language registry.
 * Maps file extensions and language names to WASM grammar files
 * from tree-sitter-wasms package.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Resolve WASM assets from the installed packages directly (layout-independent:
// works under tsx from src/, compiled dist/, and any node_modules hoisting),
// rather than a hardcoded "../../../node_modules" path relative to this file.
const webTreeSitterWasm = resolve(dirname(require.resolve('web-tree-sitter')), 'tree-sitter.wasm');
const treeSitterWasmsOut = resolve(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

let initialized = false;
const languageCache = new Map<string, Parser.Language>();

/** Ensure web-tree-sitter WASM runtime is initialized (once). */
export async function initTreeSitter(): Promise<void> {
  if (initialized) return;
  await Parser.init({ locateFile: () => webTreeSitterWasm });
  initialized = true;
}

/** Grammar info for a supported language. */
interface GrammarInfo {
  /** WASM filename inside tree-sitter-wasms/out/ */
  wasmFile: string;
  /** Canonical language name (matches LLMFileAnalysis.language) */
  language: string;
}

/**
 * Maps file extensions to grammar info.
 * Extensions are lowercase without the dot.
 */
const EXTENSION_MAP: Record<string, GrammarInfo> = {
  // TypeScript
  ts:   { wasmFile: 'tree-sitter-typescript.wasm', language: 'typescript' },
  tsx:  { wasmFile: 'tree-sitter-tsx.wasm',        language: 'tsx' },
  mts:  { wasmFile: 'tree-sitter-typescript.wasm', language: 'typescript' },
  cts:  { wasmFile: 'tree-sitter-typescript.wasm', language: 'typescript' },
  // JavaScript
  js:   { wasmFile: 'tree-sitter-javascript.wasm', language: 'javascript' },
  jsx:  { wasmFile: 'tree-sitter-javascript.wasm', language: 'javascript' },
  mjs:  { wasmFile: 'tree-sitter-javascript.wasm', language: 'javascript' },
  cjs:  { wasmFile: 'tree-sitter-javascript.wasm', language: 'javascript' },
  // Python
  py:   { wasmFile: 'tree-sitter-python.wasm',     language: 'python' },
  pyi:  { wasmFile: 'tree-sitter-python.wasm',     language: 'python' },
  // Go
  go:   { wasmFile: 'tree-sitter-go.wasm',         language: 'go' },
  // Rust
  rs:   { wasmFile: 'tree-sitter-rust.wasm',       language: 'rust' },
  // Java
  java: { wasmFile: 'tree-sitter-java.wasm',       language: 'java' },
  // C#
  cs:   { wasmFile: 'tree-sitter-c_sharp.wasm',    language: 'csharp' },
  // Kotlin
  kt:   { wasmFile: 'tree-sitter-kotlin.wasm',     language: 'kotlin' },
  kts:  { wasmFile: 'tree-sitter-kotlin.wasm',     language: 'kotlin' },
  // Swift
  swift:{ wasmFile: 'tree-sitter-swift.wasm',      language: 'swift' },
  // Ruby
  rb:   { wasmFile: 'tree-sitter-ruby.wasm',       language: 'ruby' },
  // PHP
  php:  { wasmFile: 'tree-sitter-php.wasm',        language: 'php' },
  // C / C++
  c:    { wasmFile: 'tree-sitter-c.wasm',          language: 'c' },
  h:    { wasmFile: 'tree-sitter-c.wasm',          language: 'c' },
  cpp:  { wasmFile: 'tree-sitter-cpp.wasm',        language: 'cpp' },
  cc:   { wasmFile: 'tree-sitter-cpp.wasm',        language: 'cpp' },
  cxx:  { wasmFile: 'tree-sitter-cpp.wasm',        language: 'cpp' },
  hpp:  { wasmFile: 'tree-sitter-cpp.wasm',        language: 'cpp' },
  hh:   { wasmFile: 'tree-sitter-cpp.wasm',        language: 'cpp' },
  // Bash
  sh:   { wasmFile: 'tree-sitter-bash.wasm',       language: 'bash' },
  bash: { wasmFile: 'tree-sitter-bash.wasm',       language: 'bash' },
  zsh:  { wasmFile: 'tree-sitter-bash.wasm',       language: 'bash' },
  // Data / Config
  json: { wasmFile: 'tree-sitter-json.wasm',       language: 'json' },
  yaml: { wasmFile: 'tree-sitter-yaml.wasm',       language: 'yaml' },
  yml:  { wasmFile: 'tree-sitter-yaml.wasm',       language: 'yaml' },
  toml: { wasmFile: 'tree-sitter-toml.wasm',       language: 'toml' },
  // Web
  html: { wasmFile: 'tree-sitter-html.wasm',       language: 'html' },
  htm:  { wasmFile: 'tree-sitter-html.wasm',       language: 'html' },
  css:  { wasmFile: 'tree-sitter-css.wasm',        language: 'css' },
  // SCSS / Sass / Less / Stylus reuse the CSS grammar — tree-sitter is
  // error-tolerant, so SCSS-only constructs (nested selectors, @mixin,
  // parent &) appear as ERROR nodes but top-level rule_set / at_rule
  // continue to parse. Good enough for skeleton purposes; a dedicated
  // SCSS wasm can replace this later if precision becomes an issue.
  scss: { wasmFile: 'tree-sitter-css.wasm',        language: 'css' },
  sass: { wasmFile: 'tree-sitter-css.wasm',        language: 'css' },
  less: { wasmFile: 'tree-sitter-css.wasm',        language: 'css' },
  styl: { wasmFile: 'tree-sitter-css.wasm',        language: 'css' },
  vue:  { wasmFile: 'tree-sitter-vue.wasm',        language: 'vue' },
  // Other
  dart: { wasmFile: 'tree-sitter-dart.wasm',       language: 'dart' },
  scala:{ wasmFile: 'tree-sitter-scala.wasm',      language: 'scala' },
  lua:  { wasmFile: 'tree-sitter-lua.wasm',        language: 'lua' },
  zig:  { wasmFile: 'tree-sitter-zig.wasm',        language: 'zig' },
  sol:  { wasmFile: 'tree-sitter-solidity.wasm',   language: 'solidity' },
};

/**
 * Languages that have full symbol extraction support (queries written).
 * Others can still be parsed for basic structure but won't extract symbols.
 */
const EXTRACTABLE_LANGUAGES = new Set([
  'typescript', 'tsx', 'javascript',
  'python',
  'go',
  'rust',
  'java',
  'csharp',
  'kotlin',
  'ruby',
  'cpp', 'c',
  'php',
  'swift',
  // Web markup / styles — selectors and elements as symbols.
  'css', 'html', 'vue',
]);

/** Get grammar info for a file extension (without dot). Returns null if unsupported. */
export function getGrammarForExtension(ext: string): GrammarInfo | null {
  return EXTENSION_MAP[ext.toLowerCase()] ?? null;
}

/** Check if a language has full symbol extraction support. */
export function isExtractable(language: string): boolean {
  return EXTRACTABLE_LANGUAGES.has(language);
}

/** Load (and cache) a tree-sitter Language from a WASM file name. */
export async function loadLanguage(wasmFile: string): Promise<Parser.Language> {
  const cached = languageCache.get(wasmFile);
  if (cached) return cached;

  const wasmPath = resolve(treeSitterWasmsOut, wasmFile);
  const lang = await Parser.Language.load(wasmPath);
  languageCache.set(wasmFile, lang);
  return lang;
}

/** Create a fresh Parser instance with the given language loaded. */
export async function createParser(wasmFile: string): Promise<Parser> {
  await initTreeSitter();
  const lang = await loadLanguage(wasmFile);
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

/** Get all supported file extensions. */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_MAP);
}

/**
 * Drop the cached `Parser.Language` references so future loads re-read the
 * wasm. NOTE: this does NOT return memory to the OS — web-tree-sitter
 * 0.24.7 has no `Language.delete()` and the emscripten heap never shrinks.
 * It is a growth ceiling + clean-shutdown affordance, paired with the
 * shared extractor's idle disposal. `initialized` is intentionally left
 * set: `Parser.init` is once-per-process in web-tree-sitter.
 */
export function clearLanguageCache(): void {
  languageCache.clear();
}
