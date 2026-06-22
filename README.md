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

## How it works (broker)

```
VS Code Copilot ─┐                                   ┌─ chokidar watcher (incremental reindex)
                 ├─ spawn(stdio) → shim ──HTTP loop→ DAEMON ─┼─ SQLite index + sqlite-vec
IntelliJ Copilot ┘   (MCP proxy)   (1 per editor)            └─ hybrid search + reranker + MCP tools
```

One **daemon** per project indexes + watches + serves (one warm index). Each editor spawns a
tiny **stdio shim** that proxies MCP calls to the daemon, so VS Code and IntelliJ share the same
index. The shim auto-starts the daemon on first use (lockfile under `<root>/.mcp-context/`).

## Install & build

```bash
pnpm install      # builds native modules (better-sqlite3, sqlite-vec, onnxruntime-node) for Node
pnpm build        # tsc + tsc-alias → dist/
```

Requires Node 22+.

## Run

```bash
# What an editor runs (stdio shim; auto-starts the daemon):
node dist/cli/index.js context /path/to/your/repo

# Run the daemon directly (foreground), e.g. to watch logs:
node dist/cli/index.js context /path/to/your/repo --daemon

# Structural + FTS only (skip local embeddings / model download):
node dist/cli/index.js context /path/to/your/repo --daemon --no-embeddings
```

On first run with embeddings enabled, the local model (~100 MB, `Xenova/multilingual-e5-small`)
downloads once to `~/.mcp/models`. Search serves immediately in FTS mode and upgrades to
semantic/hybrid as embeddings land in the background.

## Editor setup (Copilot **Agent mode** required)

### VS Code — `.vscode/mcp.json` (commit it to share with the repo)

```json
{
  "servers": {
    "code-context": {
      "command": "node",
      "args": ["/abs/path/to/code-context/dist/cli/index.js", "context", "${workspaceFolder}"],
      "env": { "MCP_SERVER_NAME": "code-context", "MCP_OUTPUT_CAP_LEVEL": "economic" }
    }
  }
}
```

Open Copilot Chat → switch the mode dropdown to **Agent** (MCP tools are invisible in Ask/Edit).

### JetBrains (IntelliJ IDEA / PyCharm / WebStorm)

GitHub Copilot icon in the status bar → **Edit Settings** → **Model Context Protocol** →
**Configure** (this opens the global `~/.config/github-copilot/intellij/mcp.json`). Add:

```json
{
  "servers": {
    "code-context": {
      "command": "node",
      "args": ["/abs/path/to/code-context/dist/cli/index.js", "context", "<project root>"]
    }
  }
}
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
`get_dependents`.

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
