# code-context

A local, offline **code-context server** that indexes a repository and exposes dense
code-retrieval tools to AI coding assistants over the **Model Context Protocol (MCP)**.
It is designed to make **GitHub Copilot** (VS Code *and* JetBrains/IntelliJ, agent mode)
smarter and cheaper by giving it high-signal, token-economical retrieval over your codebase.

- **Hybrid search** — FTS5/BM25 (lexical) + sqlite-vec KNN (semantic) merged with RRF and a
  local cross-encoder reranker. Plus a structural symbol layer (tree-sitter).
- **Offline & zero-key** — local ONNX embeddings (Xenova) + sqlite-vec. No API key required.
- **Token economy** — every tool result passes through deterministic smart-reducers and
  output caps, and the single project's name is injected server-side, so the assistant gets
  dense output and never has to supply boilerplate args.
- **Read-only** — a curated retrieval surface; the assistant keeps its own edit/run loop.

## How it works

```
1) index  (you, once)        2) serve  (the editor spawns this)
   tree-sitter + FTS  ─┐         stdio MCP server ──reads──┐
   local ONNX embeds  ─┼─→ SQLite index + sqlite-vec ←─────┤  hybrid search + reranker + tools
   reranker model     ─┘         + hardened incremental watcher (keeps it fresh live)
```

Indexing is an explicit step (`index`). The MCP server (`serve`) reads that on-disk index and
serves the tools — it connects instantly (no indexing on connect) and runs a hardened incremental
watcher so edits during a session are reflected. The index file is the shared state; multiple
editors can serve the same repo.

## Install & build

```bash
pnpm install      # builds native modules (better-sqlite3, sqlite-vec, onnxruntime-node) for Node
pnpm build        # tsc + tsc-alias → dist/
```

Requires Node 22+.

## Run

```bash
# 1. Index the repo once (foreground, shows progress). Re-run anytime to refresh.
node dist/cli/index.js index /abs/path/to/your/repo

#    Structural + FTS only (skip the local embedding model download):
node dist/cli/index.js index /abs/path/to/your/repo --no-embeddings

#    Optional: index then keep watching (a persistent background indexer):
node dist/cli/index.js index /abs/path/to/your/repo --watch

# 2. Serve over MCP (this is what the editor runs). Instant; reads the index above.
node dist/cli/index.js serve /abs/path/to/your/repo
```

On the first `index` with embeddings enabled, the local model (~100 MB,
`Xenova/multilingual-e5-small`) downloads once to `~/.mcp/models`. After that it is fully offline.
`serve` requires an **explicit, real project path** (it refuses your home dir or a drive root).

## Editor setup (Copilot **Agent mode** required)

`serve` auto-detects the open project from the editor's **MCP workspace roots** — so you usually
**don't pass a path at all**. (No prior `index` needed either: when the index is empty the agent
calls the `reindex` tool — or you can ask it to "reindex".) Pass an explicit path only if your
editor doesn't expose roots.

### VS Code — `.vscode/mcp.json` (commit it to share with the repo)

VS Code provides workspace roots automatically, so omit the path:

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

Open Copilot Chat → switch the mode dropdown to **Agent** (MCP tools are invisible in Ask/Edit).

### JetBrains (IntelliJ IDEA / PyCharm / WebStorm)

GitHub Copilot icon in the status bar → **Edit Settings** → **Model Context Protocol** →
**Configure** (this opens the global `~/.config/github-copilot/intellij/mcp.json`). Try **without a
path first** (relies on the editor exposing roots):

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

If a tool call reports *"no workspace detected"* (the JetBrains Copilot build doesn't expose roots
yet), add the **explicit absolute project path** as the last arg — `"serve", "D:/abs/path/to/your/repo"`.
```

Use Copilot Chat in **Agent** mode (MCP tools are invisible in Ask/Edit).

## Agent skill — make Copilot actually use it

The server already ships a usage guide in its MCP handshake (`instructions`), but to make
the agent *reach for* these tools, add repository **custom instructions** — the
"skill" GitHub Copilot honors in VS Code and JetBrains. Copy the template into the repo
you point Copilot at:

```
cp /abs/path/to/code-context/templates/copilot-instructions.md  <your-repo>/.github/copilot-instructions.md
```

(JetBrains also picks up nested `AGENTS.md` / `CLAUDE.md` via Settings → GitHub Copilot →
Customizations.) The template tells the agent to call `pack_context`/`search`/etc. to ground
its work before guessing or reading whole files.

## Tools exposed (read-only)

`pack_context` (one-shot dense digest — prefer this first), `search`, `grep_code`,
`search_by_kind`, `search_concepts`, `semantic_neighbors`, `get_repo_map`, `get_architecture`,
`get_project_overview`, `get_project_pulse`, `get_project_stats`, `get_file_skeleton`,
`get_file_structure`, `read_file`, `find_references`, `get_symbol_body`, `get_class_members`,
`get_hierarchy`, `find_implementations`, `prepare_edit`, `list_directory`, `get_dependencies`,
`get_dependents`, `reindex` (agent-triggered: build/refresh the index from chat — no terminal needed).

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `MCP_SERVER_NAME` | `code-context` | Name shown to the MCP client in the handshake |
| `MCP_OUTPUT_CAP_LEVEL` | `economic` | Output density: `economic`→`ultra` |
| `MCP_DATA_DIR` | `~/.code-context` | Index DB location |
| `MCP_MODEL_CACHE_DIR` | `~/.mcp/models` | Local ONNX model cache |
| `MCP_EMBEDDING_MODEL` | `Xenova/multilingual-e5-small` | Local embedding model |
| `MCP_INDEX_WORKER_URL` | — | Optional remote embeddings (Cloudflare) instead of local |
| `QDRANT_URL` / `PINECONE_HOST`+`PINECONE_API_KEY` | — | Optional remote vector store |
