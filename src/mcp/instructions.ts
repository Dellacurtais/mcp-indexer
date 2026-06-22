/**
 * Server usage guide returned in the MCP `initialize` response (`instructions`).
 *
 * This is the MCP-native equivalent of a "skill": the connecting client
 * (Copilot, Claude, any MCP host) injects it as context so the model knows when
 * and how to reach for these tools. Keep it short, prescriptive, and stable —
 * it ships on every handshake.
 */
export const SERVER_INSTRUCTIONS = `code-context indexes this repository and serves dense, read-only RETRIEVAL over it (hybrid lexical + semantic search, a tree-sitter symbol graph, and compact file/architecture digests). Use it to ground answers and edits in the real code instead of guessing — but keep your own edit/run/test loop; this server never modifies files.

Recommended flow for a coding task:
1. Orient: call \`pack_context\` with the task in plain language — one call returns the most relevant symbols (path:line — kind name — signature) plus a skeleton of the top files. (\`get_project_pulse\`/\`get_repo_map\` give a high-level overview.)
2. Search: \`search\` finds files+symbols (mode \`auto\` routes identifier-shaped queries to fast lexical FTS and natural-language to semantic). \`grep_code\` for an exact string/regex. \`search_by_kind\` to list e.g. all classes.
3. Drill: \`get_file_skeleton\`/\`get_file_structure\` for a file's symbols without bodies; \`read_file\` (supports symbol/line slicing) for specifics; \`find_references\`, \`get_symbol_body\`, \`get_class_members\`, \`get_hierarchy\`, \`find_implementations\`, \`prepare_edit\` to navigate; \`get_dependencies\`/\`get_dependents\` for the import graph.

Tips:
- Cut noise: for code, pass \`type:"symbols"\` and scope by language — \`languages:["typescript"]\` or \`exclude_languages:["css","scss","html"]\` on \`search\`, or \`language\`/\`glob\` on \`grep_code\`.
- If \`get_project_pulse\` shows 0 files (or 0% vector coverage and you need semantic search), call \`reindex\` once — it builds/refreshes the index in the background and returns immediately; re-check the pulse for progress.
- \`project_name\` is injected automatically — you can omit it.
- Prefer these tools over re-reading whole files: outputs are pre-summarized and token-capped, so they are cheaper and denser.
- Semantic results improve as background indexing completes on a fresh/large repo; lexical (FTS/grep) and structural tools work immediately.`;
