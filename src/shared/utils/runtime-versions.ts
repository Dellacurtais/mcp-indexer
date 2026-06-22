/**
 * Runtime de execução por projeto (PHP/Python) — fonte ÚNICA de parsing e escrita.
 * Persistido em `projects.runtime_versions` (JSON, migration 167). É o
 * INTERPRETADOR que o terminal/runner usam (PATH), distinto do `language_levels`
 * (migration 157), que é o alvo de análise do LSP. Sem deps de DB — reusado pela
 * UI (chip) e pelo backend (resolver de PATH).
 *
 * Valor = id opaco de runtime resolvido em spawn-time (ex.: 'managed:8.3.7',
 * 'homebrew:8.3.7', 'system'). Ausente/NULL ou chave faltando = "default do
 * sistema" (sem injeção de PATH). Node fica na coluna própria `node_version`.
 */

export type RuntimeVersionKey = 'php' | 'python';
export type RuntimeVersions = Partial<Record<RuntimeVersionKey, string>>;

const KEYS: readonly RuntimeVersionKey[] = ['php', 'python'];

/** JSON → mapa, tolerante a corrupção/shape inválido (sempre devolve um objeto). */
export function parseRuntimeVersions(json: string | null | undefined): RuntimeVersions {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as unknown;
    if (!obj || typeof obj !== 'object') return {};
    const rec = obj as Record<string, unknown>;
    const out: RuntimeVersions = {};
    for (const k of KEYS) {
      const v = rec[k];
      if (typeof v === 'string' && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Id de runtime ESCOLHIDO para a linguagem, ou undefined (= default do sistema). */
export function readRuntimeVersion(json: string | null | undefined, key: RuntimeVersionKey): string | undefined {
  return parseRuntimeVersions(json)[key];
}

/**
 * Funde a escolha no JSON e devolve o JSON atualizado, preservando as outras
 * chaves. `id` vazio/null/'system' REMOVE a chave (volta ao default do sistema).
 */
export function writeRuntimeVersion(
  json: string | null | undefined,
  key: RuntimeVersionKey,
  id: string | null | undefined,
): string {
  const next = parseRuntimeVersions(json);
  if (!id || id === 'system') delete next[key];
  else next[key] = id;
  return JSON.stringify(next);
}
