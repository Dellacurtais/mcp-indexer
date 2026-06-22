/**
 * Lista única de diretórios bloqueados ao listar uma árvore de arquivos para a UI
 * (file explorer da IDE + preview da company BuildZone). Mantém o explorer
 * responsivo — um walk de `node_modules`/`target` dominaria a resposta.
 *
 * Fonte única da verdade (W4 decompose): antes vivia duplicada em
 * `packages/api-handlers/src/files/index.ts` (conjunto rico) e em
 * `apps/http-api/server/routes/workspace/file-service.ts` (subconjunto). O array
 * é o seed canônico; o Set é o que os call-sites consultam via `.has()`.
 *
 * NÃO inclui os blocklists agent-side (`apps/mcp-server`, `services/seed-files`,
 * `code-agent/manage-path`) — contrato diferente (respeitam .gitignore/escopo).
 */
export const TREE_BLOCK_DIRS: readonly string[] = [
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache',
  '.venv', 'venv', '__pycache__', '.pytest_cache', 'target', '.idea',
  '.vscode', '.DS_Store',
];

/** Set para checagem `.has(name)` no hot path do readdir. */
export const TREE_BLOCK: ReadonlySet<string> = new Set(TREE_BLOCK_DIRS);
