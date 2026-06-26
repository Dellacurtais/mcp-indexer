/**
 * `install [root]` — scaffold the Copilot custom-instructions file so the agent
 * actually reaches for code-context. Writes the canonical
 * `.github/copilot-instructions.md` (read on every Copilot chat/agent request in
 * VS Code, JetBrains, and github.com). Optionally also a root `AGENTS.md` (the
 * cross-agent standard, also honored by Copilot coding agent) and a VS Code
 * `.vscode/mcp.json` wiring this build.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoot, log } from './shared.js';
import { runIndex } from './index-cmd.js';

// dist/cli/commands/install.js (or src/cli/commands/install.ts under tsx) →
// package root is three levels up (commands → cli → dist → root).
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEMPLATE_PATH = join(PKG_ROOT, 'templates', 'copilot-instructions.md');

/** Embedded copy used if templates/ wasn't shipped (defensive — it normally is). */
const FALLBACK_INSTRUCTIONS = `# Copilot instructions — use the \`code-context\` retrieval server

This repository is indexed by **code-context**, a local MCP server that provides
dense, read-only retrieval over the codebase (hybrid lexical + semantic search, a
tree-sitter symbol graph, and compact file/architecture digests). Prefer its
tools to ground every answer and edit in the real code — do **not** guess at APIs,
file locations, or call sites.

## How to use it (recommended flow)

1. **Orient** — call \`pack_context\` with the task in plain language (or
   \`get_project_pulse\` / \`get_architecture\` for an overview).
2. **Search** — \`search\` (mode \`auto\`), \`grep_code\` for exact strings,
   \`search_by_kind\` to list symbols of a kind.
3. **Drill** — \`get_file_skeleton\` / \`read_file\` / \`find_references\` /
   \`get_symbol_body\` / \`get_dependencies\` to navigate.

## Notes

- \`project_name\` is injected automatically — omit it.
- The server is **read-only**: keep your own edit/run/test loop.
- Prefer these tools over reading whole files — outputs are token-capped and dense.
`;

export interface InstallOpts {
  force?: boolean;
  agents?: boolean;
  mcp?: boolean;
  index?: boolean;
}

/**
 * VS Code's plan agent reads its extra tools from
 * `github.copilot.chat.planAgent.additionalTools` (experimental). MCP tools are
 * referenced as `<server-key>/<tool>` — or `<server-key>/*` for all of a
 * server's tools. The server key here is the `.vscode/mcp.json` key below.
 */
const PLAN_AGENT_SETTING = 'github.copilot.chat.planAgent.additionalTools';
const PLAN_AGENT_TOOL_REF = 'code-context/*';

/** Minimal JSONC-tolerant parse (VS Code settings.json allows // comments + trailing commas). */
function parseJsonc(text: string): Record<string, unknown> {
  let out = '';
  let inStr = false;
  let line = false;
  let block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (line) {
      if (c === '\n') { line = false; out += c; }
      continue;
    }
    if (block) {
      if (c === '*' && n === '/') { block = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1'); // tolerate trailing commas
  return JSON.parse(out) as Record<string, unknown>;
}

/**
 * Ensure `.vscode/settings.json` adds code-context to the plan agent's tools,
 * merging additively (preserves other keys + other tool entries). Creating the
 * file is clean; merging an existing one reformats it (JSON comments are lost).
 */
function ensurePlanAgentTools(root: string, force: boolean): void {
  void force;
  const vscodeDir = join(root, '.vscode');
  const path = join(vscodeDir, 'settings.json');

  if (!existsSync(path)) {
    if (!existsSync(vscodeDir)) mkdirSync(vscodeDir, { recursive: true });
    writeFileSync(path, JSON.stringify({ [PLAN_AGENT_SETTING]: [PLAN_AGENT_TOOL_REF] }, null, 2) + '\n', 'utf8');
    log(`wrote .vscode/settings.json — plan agent uses "${PLAN_AGENT_TOOL_REF}"`);
    return;
  }

  let obj: Record<string, unknown>;
  try {
    obj = parseJsonc(readFileSync(path, 'utf8'));
  } catch {
    log(`skip .vscode/settings.json — could not parse it. Add manually:  "${PLAN_AGENT_SETTING}": ["${PLAN_AGENT_TOOL_REF}"]`);
    return;
  }
  const cur = Array.isArray(obj[PLAN_AGENT_SETTING]) ? (obj[PLAN_AGENT_SETTING] as unknown[]).map(String) : [];
  if (cur.includes(PLAN_AGENT_TOOL_REF)) {
    log(`.vscode/settings.json already grants the plan agent "${PLAN_AGENT_TOOL_REF}"`);
    return;
  }
  obj[PLAN_AGENT_SETTING] = [...cur, PLAN_AGENT_TOOL_REF];
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  log(`updated .vscode/settings.json — added "${PLAN_AGENT_TOOL_REF}" to ${PLAN_AGENT_SETTING} (note: reformatted; JSON comments not preserved)`);
}

function loadTemplate(): string {
  try {
    return readFileSync(TEMPLATE_PATH, 'utf8');
  } catch {
    return FALLBACK_INSTRUCTIONS;
  }
}

function writeIfAbsent(path: string, content: string, force: boolean, label: string): void {
  if (existsSync(path) && !force) {
    log(`skip ${label} — already exists (use --force to overwrite)`);
    return;
  }
  writeFileSync(path, content, 'utf8');
  log(`${existsSync(path) && force ? 'overwrote' : 'wrote'} ${label}`);
}

export async function runInstall(rootArg: string | undefined, opts: InstallOpts): Promise<void> {
  const root = resolveRoot(rootArg ?? process.cwd());
  const instructions = loadTemplate();
  const serveEntry = join(PKG_ROOT, 'dist', 'cli', 'index.js').replace(/\\/g, '/');

  // .github/copilot-instructions.md — the canonical Copilot repo instructions.
  const githubDir = join(root, '.github');
  if (!existsSync(githubDir)) {
    mkdirSync(githubDir, { recursive: true });
    log('created .github/');
  }
  writeIfAbsent(join(githubDir, 'copilot-instructions.md'), instructions, !!opts.force, '.github/copilot-instructions.md');

  // AGENTS.md — cross-agent standard (Copilot coding agent, Cursor, etc.).
  if (opts.agents) {
    writeIfAbsent(join(root, 'AGENTS.md'), instructions, !!opts.force, 'AGENTS.md');
  }

  // .vscode/mcp.json — wire the MCP server for VS Code (this build's dist path).
  if (opts.mcp) {
    const mcpJson =
      JSON.stringify(
        {
          servers: {
            'code-context': {
              command: 'node',
              args: [serveEntry, 'serve'],
              env: { MCP_SERVER_NAME: 'code-context', MCP_OUTPUT_CAP_LEVEL: 'economic' },
            },
          },
        },
        null,
        2,
      ) + '\n';
    const vscodeDir = join(root, '.vscode');
    if (!existsSync(vscodeDir)) mkdirSync(vscodeDir, { recursive: true });
    writeIfAbsent(join(vscodeDir, 'mcp.json'), mcpJson, !!opts.force, '.vscode/mcp.json');
    // Also expose the tools to VS Code's (experimental) Plan agent so /plan
    // researches with code-context, not just agent mode.
    ensurePlanAgentTools(root, !!opts.force);
  }

  if (opts.index) {
    log('');
    log('indexing (first run downloads the local embedding model ~100MB) …');
    await runIndex(root, { noEmbeddings: false });
  }

  log('');
  log('Next steps:');
  if (!opts.index) log(`  • Index the repo:   code-context index "${root}"`);
  if (!opts.mcp) {
    log('  • Configure the MCP server in your editor:');
    log('       VS Code   → re-run with --mcp, or add .vscode/mcp.json');
    log(`       JetBrains → ~/.config/github-copilot/intellij/mcp.json → "args": ["${serveEntry}", "serve"]`);
  } else {
    log(`  • JetBrains too? add to ~/.config/github-copilot/intellij/mcp.json → "args": ["${serveEntry}", "serve"]`);
    log(`  • Plan agent: ${PLAN_AGENT_SETTING} now includes "${PLAN_AGENT_TOOL_REF}" (.vscode/settings.json).`);
  }
  log('  • Open Copilot Chat in AGENT mode (the tools are hidden in Ask/Edit).');
}
