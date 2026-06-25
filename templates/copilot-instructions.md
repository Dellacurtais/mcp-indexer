# Copilot instructions — use the `code-context` retrieval server

This repository is indexed by **code-context**, a local MCP server that provides
dense, read-only retrieval over the codebase (hybrid lexical + semantic search, a
tree-sitter symbol graph, and compact file/architecture digests). Prefer its
tools to ground every answer and edit in the real code — do **not** guess at APIs,
file locations, or call sites.

## When to use it

- **Before** answering a question about the codebase, locating where something
  lives, or planning an edit that spans files you haven't opened.
- Instead of reading whole files: its outputs are pre-summarized and token-capped,
  so they are cheaper and denser than raw file reads.

## How to use it (recommended flow)

1. **Orient** — call `pack_context` with a `query` describing the task in plain
   language. One call returns the most relevant symbols (`path:line — kind name —
   signature`) plus a skeleton of the top files. (`get_project_pulse` /
   `get_repo_map` for a high-level overview.)
2. **Search** — `search` (mode `auto` routes identifiers → fast lexical FTS and
   natural language → semantic). `grep_code` for an exact string/regex.
   `search_by_kind` to list e.g. all classes.
3. **Drill** — `get_file_skeleton` / `get_file_structure` for a file's symbols
   without bodies; `read_file` (supports symbol/line slicing) for specifics;
   `find_references`, `get_symbol_body`, `get_class_members`, `get_hierarchy`,
   `find_implementations`, `prepare_edit` to navigate; `get_dependencies` /
   `get_dependents` for the import graph.

## Notes

- `project_name` is injected automatically — you can omit it.
- The server is **read-only**: it never edits, runs, or tests. Keep your own
  edit/run/test loop; use code-context only to find and understand code.
- On a fresh or very large repo, semantic results improve as background indexing
  completes; lexical (FTS/grep) and structural tools work immediately.
