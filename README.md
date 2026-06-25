# code-context

**English** · [Português (pt-BR)](README.pt-BR.md)

A local, offline **code-context server** that indexes a repository and exposes dense
code-retrieval tools to AI coding assistants over the **Model Context Protocol (MCP)**.
It makes **GitHub Copilot** (VS Code *and* JetBrains/IntelliJ, agent mode) smarter and
cheaper by giving it high-signal, token-economical retrieval over your codebase — so the
agent stops reading whole files to guess, and grounds its work in the index instead.

- **Hybrid search** — FTS5/BM25 (lexical) + sqlite-vec KNN (semantic) merged with RRF and a
  local cross-encoder reranker, over a structural symbol layer (tree-sitter).
- **Offline & zero-key** — local ONNX embeddings (Xenova) + sqlite-vec. No API key required.
- **Token economy** — every tool result passes through deterministic smart-reducers and output
  caps, results are dense Markdown (no JSON boilerplate), and the project name is injected
  server-side so the agent never supplies it.
- **Read-only** — a curated retrieval surface; the assistant keeps its own edit/run loop.
- **Optional paid enrichment** — an opt-in, budgeted AWS Bedrock pass adds file summaries and
  verified architecture layers where it matters most. Off by default; the core is 100% local.

---

## Table of contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install & build](#install--build)
- [Global CLI install](#global-cli-install)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [Indexing](#indexing)
- [Optional: `enrich` (AWS Bedrock)](#optional-enrich--llm-summaries--layers-aws-bedrock)
- [Configuration & `.env`](#configuration--env)
- [Editor setup (Copilot agent mode)](#editor-setup-copilot-agent-mode)
- [Agent skill (make Copilot use it)](#agent-skill--make-copilot-use-it)
- [Tools exposed](#tools-exposed-read-only)
- [Data & storage](#data--storage)
- [Troubleshooting](#troubleshooting)
- [Publishing & distribution](#publishing--distribution)

---

## How it works

```
1) index  (you, once)            2) serve  (the editor spawns this)
   tree-sitter + FTS  ─┐            stdio MCP server ──reads──┐
   local ONNX embeds  ─┼─→ SQLite index + sqlite-vec ←────────┤  hybrid search + reranker + tools
   reranker model     ─┘            + hardened incremental watcher (keeps it fresh live)
```

Indexing is an explicit step (`index`). The MCP server (`serve`) reads that on-disk index and
serves the tools — it connects **instantly** (no indexing on connect) and runs a hardened
incremental watcher so edits during a session are reflected. The index file is the shared state;
multiple editors can serve the same repo.

Layers shown by `get_architecture` are derived **locally and for free** from path/role heuristics
+ the dependency graph (works across TypeScript/Angular, .NET, Python, PHP, Java, Go…). The
optional `enrich` pass upgrades the most important files with LLM-verified summaries and layers.

---

## Requirements

- **Node 22+** (the native modules are built for the Node ABI).
- **pnpm** (`npm i -g pnpm`).
- Native toolchain for `better-sqlite3` / `onnxruntime-node` (prebuilt binaries cover most
  platforms; Windows/macOS/Linux x64 + arm64 work out of the box).
- *(optional)* AWS account with Bedrock model access — only for `enrich`.

---

## Install & build

```bash
git clone <repo-url> code-context && cd code-context
pnpm install      # builds native modules (better-sqlite3, sqlite-vec, onnxruntime-node)
pnpm build        # tsc + tsc-alias → dist/
```

> The repo ships an `.npmrc` with `shamefully-hoist=true`. It's required so the optional AWS SDK's
> deep transitive tree resolves at runtime under pnpm — leave it in place.

---

## Global CLI install

Put `code-context` on your PATH as a symlink to your build, so `pnpm build` updates it with no
reinstall:

```bash
cd /abs/path/to/code-context && npm link     # → `code-context` available everywhere
# update after code changes:  pnpm build      (the linked command points at dist/)
# uninstall:                  npm unlink -g code-context
```

(For distributing to others without the source, see [Publishing & distribution](#publishing--distribution).)

---

## Quick start

```bash
# 1. Index the repo once (foreground, shows progress). Re-run anytime to refresh.
code-context index /abs/path/to/your/repo

# 2. Check coverage.
code-context status /abs/path/to/your/repo

# 3. Query from the terminal (sanity check).
code-context search "where is auth handled" /abs/path/to/your/repo

# 4. Point your editor at `serve` (see Editor setup) — that's what Copilot talks to.
```

On the first `index` with embeddings enabled, the local model (~100 MB,
`Xenova/multilingual-e5-small`) downloads once to `~/.mcp/models`; after that it's fully offline.
`serve` requires an **explicit, real project path** or editor-provided roots (it refuses your home
dir or a drive root).

---

## CLI reference

```bash
code-context index   [repo]             # build/refresh the index   (--watch, --no-embeddings)
code-context serve   [repo]             # the MCP server for an editor (omit repo to auto-detect roots)
code-context status  [repo]             # files / symbols / vector coverage
code-context search  "<query>" [repo]   # query the index  (--mode, --type, --limit, --lang, --exclude-lang)
code-context enrich  [repo]             # OPTIONAL paid LLM pass (AWS Bedrock) — see below
code-context install [repo]             # scaffold .github/copilot-instructions.md  (--mcp, --agents, --force)
code-context projects                   # list every indexed project
```

| Command | Key options |
|---|---|
| `index` | `--no-embeddings` (structural + FTS only, skip the model), `--watch` (stay alive, incremental) |
| `serve` | `--no-embeddings`, `--no-watch` |
| `search` | `--mode auto\|fts\|vector\|hybrid`, `--type files\|symbols\|all`, `--limit <n>`, `--lang ts,py`, `--exclude-lang css,scss` |
| `enrich` | `--limit`, `--budget`, `--model`, `--inference`, `--min-lines`, `--mock`, `--dry-run`, `--synthesize` |

`[repo]` is optional everywhere — `cd` into your repo and omit it, and the command uses the
**current directory** (the home dir / a drive root are refused). All projects share one index at
`~/.code-context/index.db` (override with `MCP_DATA_DIR`).

---

## Indexing

- **Incremental by default** — re-running `index` only reprocesses files whose content hash
  changed (stat-first scan). Cheap to run often.
- **`--watch`** keeps the process alive and refreshes the index on file changes (debounced). The
  `serve` command runs the same watcher in-process during an editor session (disable with
  `--no-watch`).
- **`--no-embeddings`** skips the ONNX model entirely — you still get tree-sitter symbols + FTS
  (grep/skeleton/structure work), just no semantic vector search.
- **What's ignored** — `node_modules`, `.git`, build output (`dist`, `build`, `target`, `obj`, `.vs`,
  `.angular`, …), the repo's root `.gitignore`, and binaries, all automatically. Add a
  **`.mcpindexignore`** file at the repo root (same syntax as `.gitignore`) for project-specific rules.
- **Offline / air-gapped** — the embedding model (~100 MB) downloads on first index to
  `~/.mcp/models`. Pre-seed it (copy the cache, or set `MCP_MODEL_CACHE_DIR` to a shared location) to
  index with embeddings without network access.

---

## Optional: `enrich` — LLM summaries & layers (AWS Bedrock)

Everything above is local and free. `enrich` optionally pays an LLM to add **one-line file
summaries**, **concept tags**, **verified layers**, and a **project architecture synthesis** for
the **most depended-on files** — exactly what most reduces an agent's investigative reading. It's
**off** unless you ask for it, and it's budgeted.

```bash
# Preview the targets (ranked by in-degree) — no AWS, no cost:
code-context enrich <repo> --dry-run

# Run the whole pipeline offline with fake summaries (proves the wiring, no AWS):
code-context enrich <repo> --mock --synthesize

# Real run — credentials from your env / ~/.aws / instance role (see Configuration):
export CODE_CONTEXT_ANALYSIS=bedrock
code-context enrich <repo> --limit 100 --budget 0.50

# Inference-profile-only models (Nova, newer Claude) need a region prefix:
code-context enrich <repo> --model amazon.nova-lite-v1:0 --inference        # → us./eu./apac.
code-context enrich <repo> --model us.anthropic.claude-3-5-sonnet-20241022-v2:0
```

**How it stays cheap and useful**

- **Targets only stale, high-in-degree files** — the `semantic_hash` gate means a re-run after
  edits re-touches just the changed files; `--limit` caps how many you pay for; `--min-lines`
  skips trivially small files.
- **Budget hard-stop** — `--budget <usd>` (default `$MCP_INDEX_BUDGET` or `$1.00`) stops the run
  when spend is reached; every call's cost is logged (`code-context status` / cost table).
- **Model** — default `amazon.titan-text-express-v1`. Override with `--model` /
  `CODE_CONTEXT_ANALYSIS_MODEL`. Uses the Bedrock **Converse** API, so Titan, Nova, Claude, Llama,
  etc. all work through one path.
- **Results flow automatically** into `get_file_skeleton` (a `Summary:` line),
  `get_file_structure`, `get_architecture` (real layers + a synthesis paragraph at the top), and
  `get_project_pulse`. Nothing else to wire — restart the editor's MCP server to see it.

**Dependency footprint** — `@aws-sdk/client-bedrock-runtime` ships as an **optional dependency**:
`pnpm install` pulls it by default but it's loaded lazily, so `index`/`serve`/`search` never touch
it. To skip it entirely: `pnpm install --no-optional`.

---

## Optional: Bedrock reranker

After the FTS + vector merge, search re-ranks the top candidates with a cross-encoder. The default
is a **local ONNX** model (offline, fast, free). You can swap in a **Bedrock rerank model**
(`amazon.rerank-v1:0`, `cohere.rerank-v3-5:0`) for higher precision:

```dotenv
# in your shell or ~/.code-context/.env  (reuses the AWS_* creds)
CODE_CONTEXT_RERANK=bedrock
CODE_CONTEXT_RERANK_MODEL=amazon.rerank-v1:0     # optional; or cohere.rerank-v3-5:0 / a full ARN
```

> **Trade-off:** the reranker runs on **every search**, so a network backend adds latency and a
> **per-query Bedrock cost** to each query. Prefer the local reranker unless you specifically want
> the extra precision. If a Bedrock call fails (no creds, throttle), search falls back to the RRF
> order — it never breaks. Uses `@aws-sdk/client-bedrock-agent-runtime` (also an optional dep).

---

## Configuration & `.env`

Instead of exporting variables, drop them in a `.env` file. Two locations are loaded, in this
precedence:

```
shell env   >   ./.env (cwd)   >   ~/.code-context/.env (global)
```

The **global** `~/.code-context/.env` is loaded no matter where you run `code-context` — the best
home for credentials. Copy [`.env.example`](.env.example) to get started:

```dotenv
# ~/.code-context/.env   (Windows: C:\Users\<you>\.code-context\.env)
CODE_CONTEXT_ANALYSIS=bedrock
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
# optional:
# CODE_CONTEXT_ANALYSIS_MODEL=amazon.nova-lite-v1:0
# CODE_CONTEXT_ANALYSIS_INFERENCE=1
# MCP_INDEX_BUDGET=1.00
```

Because the global `.env` is also read by `serve`, enrichment works straight from the editor's MCP
server too — no credentials in the editor launcher config.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `MCP_SERVER_NAME` | `code-context` | Name shown to the MCP client in the handshake |
| `MCP_OUTPUT_CAP_LEVEL` | `economic` | Output density: `economic` → `ultra` |
| `MCP_TOOLS` | `core` | Tool surface: `core` (~11, leaner = better agent tool-selection), `full` (all 24), or a comma list of tool names |
| `MCP_DATA_DIR` | `~/.code-context` | Index DB + global `.env` location |
| `MCP_MODEL_CACHE_DIR` | `~/.mcp/models` | Local ONNX model cache |
| `MCP_EMBEDDING_MODEL` | `Xenova/multilingual-e5-small` | Local embedding model |
| `MCP_EMBEDDINGS` | — | `bedrock` → use AWS Titan embeddings instead of local ONNX (PAID; reuses `AWS_*`; **re-index required** — 1024-dim vs 384). `remote` → Cloudflare (with `MCP_INDEX_WORKER_URL`) |
| `CODE_CONTEXT_EMBED_MODEL` | `amazon.titan-embed-text-v2:0` | Bedrock embedding model id |
| `MCP_INDEX_BUDGET` | `1.00` | Default USD cap for an `enrich` run |
| `CODE_CONTEXT_ANALYSIS` | — | `bedrock` or `mock` — enables the `enrich` provider |
| `CODE_CONTEXT_ANALYSIS_MODEL` | `amazon.titan-text-express-v1` | Bedrock model id |
| `CODE_CONTEXT_ANALYSIS_INFERENCE` | — | `1` → prepend the region inference-profile prefix |
| `CODE_CONTEXT_RERANK` | — | reranker backend: `bedrock` (Bedrock model), `none` (RRF-only — disables the **local ONNX reranker**, for a no-ONNX setup); unset = local ONNX |
| `CODE_CONTEXT_RERANK_MODEL` | `amazon.rerank-v1:0` | Bedrock rerank model id (or `cohere.rerank-v3-5:0` / a full ARN) |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` | — | Bedrock credentials (or use `~/.aws`, SSO, instance role) |
| `MCP_INDEX_WORKER_URL` | — | Optional remote embeddings (Cloudflare) instead of local |
| `QDRANT_URL` / `PINECONE_HOST`+`PINECONE_API_KEY` | — | Optional remote vector store |

---

## Editor setup (Copilot **agent mode**)

`serve` auto-detects the open project from the editor's **MCP workspace roots** — so you usually
**don't pass a path**. No prior `index` is required either: when the index is empty the agent can
call the `reindex` tool (or just ask it to "reindex"). Pass an explicit path only if your editor
doesn't expose roots.

> MCP tools are only visible in Copilot Chat's **Agent** mode (not Ask/Edit).

### VS Code — `.vscode/mcp.json` (commit it to share with the repo)

```json
{
  "servers": {
    "code-context": {
      "command": "node",
      "args": ["/abs/path/to/code-context/dist/cli/index.js", "serve"],
      "env": { "MCP_SERVER_NAME": "code-context", "MCP_OUTPUT_CAP_LEVEL": "economic" }
    }
  }
}
```

### JetBrains (IntelliJ IDEA / PyCharm / WebStorm)

Copilot icon in the status bar → **Edit Settings** → **Model Context Protocol** → **Configure**
(opens the global `~/.config/github-copilot/intellij/mcp.json`). Try **without a path** first:

```json
{
  "servers": {
    "code-context": {
      "command": "node",
      "args": ["/abs/path/to/code-context/dist/cli/index.js", "serve"],
      "env": { "MCP_SERVER_NAME": "code-context" }
    }
  }
}
```

If a tool reports *"no workspace detected"* (some JetBrains Copilot builds don't expose roots yet),
add the **explicit absolute path** as the last arg: `"serve", "D:/abs/path/to/your/repo"`.

---

## Agent skill — make Copilot use it

The server ships a usage guide in its MCP handshake (`instructions`), but to make the agent *reach
for* these tools, add repository **custom instructions** — the "skill" Copilot honors in VS Code,
JetBrains and github.com. The canonical file is `.github/copilot-instructions.md` (read on every
Copilot chat/agent request). Scaffold it with one command from inside your repo:

```bash
code-context install                 # writes <repo>/.github/copilot-instructions.md
code-context install --mcp --index   # …and .vscode/mcp.json + build the index now (one-shot setup)
code-context install --agents        # …and a root AGENTS.md (cross-agent standard)
# --force overwrites an existing file; pass a path to target another repo.
```

The instructions tell the agent to call `pack_context`/`search`/etc. to ground its work before
guessing or reading whole files. (Prefer `.github/copilot-instructions.md`; `AGENTS.md` is the
emerging cross-tool standard and coexists with it — JetBrains also reads nested `AGENTS.md` /
`CLAUDE.md` via Settings → GitHub Copilot → Customizations.)

---

## Tools exposed (read-only)

**Start here:** `pack_context` (one-shot dense digest), `get_project_pulse`, `get_architecture`,
`get_repo_map`.

| Group | Tools |
|---|---|
| Orientation | `pack_context`, `get_project_pulse`, `get_project_overview`, `get_project_stats`, `get_architecture`, `get_repo_map` |
| Search | `search`, `grep_code`, `search_by_kind`, `search_concepts`, `semantic_neighbors` |
| File / outline | `get_file_skeleton`, `get_file_structure`, `read_file`, `list_directory` |
| Symbols | `find_references`, `get_symbol_body`, `get_class_members`, `get_hierarchy`, `find_implementations`, `prepare_edit` |
| Graph | `get_dependencies`, `get_dependents` |
| Index | `reindex` (agent-triggered build/refresh from chat — no terminal needed) |

By default `serve` advertises a **lean core** (~11 tools) — agents pick tools more accurately from a
small set. Set `MCP_TOOLS=full` for the whole table above, or `MCP_TOOLS=search,read_file,…` for a
custom subset. All results are dense Markdown; pass `--lang`/`--exclude-lang` (search) to cut noise.

---

## Data & storage

```
~/.code-context/
├── index.db          # the SQLite index (FTS + sqlite-vec + symbols) for every project
└── .env              # optional global config (loaded by every command incl. serve)

~/.mcp/models/        # cached local ONNX models (embeddings + reranker)
```

Override the data dir with `MCP_DATA_DIR`. The index is the only shared state — deleting it just
means the next `index` rebuilds from scratch.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **`serve` says "no workspace detected"** | Your editor didn't expose MCP roots — pass the explicit repo path as the last `serve` arg. |
| **MCP tools not visible** | You're in Copilot **Ask/Edit** mode — switch the chat dropdown to **Agent**. |
| **`enrich`: "requires @aws-sdk/client-bedrock-runtime"** | Optional dep was skipped — run `pnpm install` (without `--no-optional`). |
| **`enrich`: `CredentialsProviderError`** | No AWS creds — set them in `~/.code-context/.env` or your shell / `~/.aws`. |
| **`enrich`: model "ValidationException / inference profile"** | The model needs an inference profile — pass `--inference` or the full `us.`/`eu.`/`apac.` id. |
| **`pnpm install` → `ERR_PNPM_EPERM: unlink better_sqlite3.node` (Windows)** | A running `code-context serve` (often launched by the IDE's Copilot LSP) holds the native module open. Stop/pause Copilot (or kill the `code-context serve` / `copilot-language-server` process), then reinstall. |
| **`Cannot find module 'tslib'` from `@aws-sdk`** | The `.npmrc` `shamefully-hoist=true` must be present, and `tslib` is a pinned dep — re-run `pnpm install`. |
| **`better-sqlite3` ABI / `NODE_MODULE_VERSION` mismatch** | Native module built for a different Node — `pnpm rebuild better-sqlite3` under Node 22. |
| **Embeddings stuck at low %** | Run `code-context index <repo>` from the terminal (worker-backed backfill) and watch `code-context status`. |

---

## Publishing & distribution

The package is marked `"private": true` as a safety guard. Pick a distribution channel:

### A. Tarball (simplest — share a file, no registry)

```bash
pnpm build
npm pack                       # → code-context-0.1.0.tgz  (contains dist/ + templates/ + .env.example)

# on the target machine (Node 22+):
npm i -g ./code-context-0.1.0.tgz     # installs the `code-context` bin + rebuilds native modules
```

### B. npm registry (public or private)

1. In `package.json`, remove `"private": true` (or set it `false`), and ensure a publish allowlist
   + build hook so only the built artifacts ship:

   ```jsonc
   {
     "files": ["dist", "templates", ".env.example", "README.md"],
     "scripts": { "prepublishOnly": "pnpm build" }
   }
   ```

2. Publish:

   ```bash
   npm login                       # (or set //registry/:_authToken in ~/.npmrc for a private registry)
   npm publish                     # public
   npm publish --access public     # public scoped package (@scope/code-context)
   ```

   For a **private registry** (Verdaccio, GitHub Packages, CodeArtifact, Artifactory), point
   `publishConfig.registry` in `package.json` (or `~/.npmrc`) at it and `npm publish`.

3. Consumers install the global bin:

   ```bash
   npm i -g code-context           # or @scope/code-context
   code-context index <repo>
   ```

### Notes for distribution

- **Native modules** (`better-sqlite3`, `onnxruntime-node`, `sqlite-vec`) rebuild on the
  consumer's `install` for their platform/ABI — no need to ship binaries.
- **The AWS SDK** is optional; consumers who never run `enrich` can install with `--no-optional`.
- **Versioning** — bump with `npm version patch|minor|major` (tags + updates `package.json`); the
  `prepublishOnly` hook guarantees `dist/` is fresh on every publish.
- **First run downloads** the ONNX model (~100 MB) to `~/.mcp/models` once, unless the consumer
  uses `--no-embeddings` or a remote embeddings backend.

---

Built to keep the assistant grounded — index once, serve everywhere, enrich where it pays off.
