/**
 * Versão da linguagem por projeto (PHP/Python) — fonte ÚNICA de parsing, escrita,
 * listas de versões e defaults. Persistido em `projects.language_levels` (JSON,
 * migration 157) e entregue ao servidor LSP (ver `lsp-config-map` no backend) para
 * que completion/hover de símbolos NATIVOS respeitem a versão. Sem deps de DB —
 * reusado pela UI (chip) e pelo backend.
 *
 * Contrato: `language_levels` ausente/NULL ou chave faltando = "usar o default do
 * servidor" (o resolver do backend devolve undefined → o server usa o próprio default).
 */

export type LangLevelKey = 'php' | 'python';
export type LangLevels = Partial<Record<LangLevelKey, string>>;

/** Níveis ofertados no dropdown (ordem crescente). Teto deve casar com o que o pacote
 *  pinado entende (intelephense 1.12.6 / pyright 1.1.405) — ver ⚠️ do plano. */
export const PHP_LEVELS = ['5.6', '7.0', '7.1', '7.2', '7.3', '7.4', '8.0', '8.1', '8.2', '8.3', '8.4'] as const;
export const PYTHON_LEVELS = ['3.7', '3.8', '3.9', '3.10', '3.11', '3.12', '3.13'] as const;

/** Default exibido (latest estável) quando nada foi escolhido. */
export const DEFAULT_PHP_LEVEL = '8.4';
export const DEFAULT_PYTHON_LEVEL = '3.13';

const LEVELS_BY_LANG: Record<LangLevelKey, readonly string[]> = { php: PHP_LEVELS, python: PYTHON_LEVELS };
const DEFAULT_BY_LANG: Record<LangLevelKey, string> = { php: DEFAULT_PHP_LEVEL, python: DEFAULT_PYTHON_LEVEL };

/** O languageId (monaco) é configurável de versão? (apenas php/python no 1º corte). */
export function isLangLevelKey(lang: string): lang is LangLevelKey {
  return lang === 'php' || lang === 'python';
}

export function levelsFor(lang: LangLevelKey): readonly string[] {
  return LEVELS_BY_LANG[lang];
}

export function defaultLevelFor(lang: LangLevelKey): string {
  return DEFAULT_BY_LANG[lang];
}

/** JSON → mapa, tolerante a corrupção/shape inválido (sempre devolve um objeto). */
export function parseLanguageLevels(json: string | null | undefined): LangLevels {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as unknown;
    if (!obj || typeof obj !== 'object') return {};
    const rec = obj as Record<string, unknown>;
    const out: LangLevels = {};
    for (const k of ['php', 'python'] as const) {
      const v = rec[k];
      if (typeof v === 'string' && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Versão ESCOLHIDA para a linguagem, ou undefined (= não enviar → server usa default). */
export function readLanguageLevel(json: string | null | undefined, lang: LangLevelKey): string | undefined {
  return parseLanguageLevels(json)[lang];
}

/** Versão EFETIVA para exibir no chip: a escolhida OU o default da linguagem. */
export function effectiveLanguageLevel(json: string | null | undefined, lang: LangLevelKey): string {
  return readLanguageLevel(json, lang) ?? defaultLevelFor(lang);
}

/** Funde a nova versão no JSON e devolve o JSON atualizado (string), preservando as outras chaves. */
export function writeLanguageLevel(json: string | null | undefined, lang: LangLevelKey, level: string): string {
  const next: LangLevels = { ...parseLanguageLevels(json), [lang]: level };
  return JSON.stringify(next);
}

// ─── Auto-detect a partir do manifesto (parsers PUROS — a leitura de FS fica no backend) ───

/** "major.minor" numérico p/ comparação (8.1 → 8001; 7.10 → 7010). -1 se inválido. */
function vnum(v: string): number {
  const m = /^(\d+)(?:\.(\d+))?/.exec(v.trim());
  return m ? Number(m[1]) * 1000 + Number(m[2] ?? 0) : -1;
}

/**
 * Piso (menor versão suportada) de uma constraint do manifesto, como "major.minor".
 * Pega o PRIMEIRO número de versão (que em constraints normais é o limite inferior):
 * ">=8.1", "^8.1", "~8.1.0", "8.1.*", ">=7.4 <8.0", "8.*" → 8.1/8.1/8.1/8.1/7.4/8.0.
 */
export function floorFromConstraint(constraint: string): string | undefined {
  const m = /(\d+)(?:\.(\d+))?/.exec(constraint);
  return m ? `${m[1]}.${m[2] ?? '0'}` : undefined;
}

/**
 * Casa uma versão "major.minor" detectada com o nível ofertado mais apropriado:
 * match exato; senão o maior nível ≤ alvo; senão (abaixo de todos) o menor da lista.
 */
export function snapToLevels(version: string, levels: readonly string[]): string | undefined {
  const target = vnum(version);
  if (target < 0) return undefined;
  let best: string | undefined;
  let bestNum = -1;
  for (const l of levels) {
    const n = vnum(l);
    if (n === target) return l;
    if (n <= target && n > bestNum) { best = l; bestNum = n; }
  }
  return best ?? levels[0];
}

/** PHP language level a partir do composer.json (config.platform.php tem prioridade sobre require.php). */
export function phpLevelFromComposer(content: string): string | undefined {
  try {
    const json = JSON.parse(content) as {
      require?: Record<string, string>;
      config?: { platform?: { php?: string } };
    };
    const raw = json.config?.platform?.php ?? json.require?.php;
    if (!raw) return undefined;
    const floor = floorFromConstraint(raw);
    return floor ? snapToLevels(floor, PHP_LEVELS) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Python language level a partir do pyproject.toml. Sem dep de TOML — regex no texto:
 * `requires-python = ">=3.10"` ([project]) OU `python = "^3.10"` ([tool.poetry.dependencies]).
 */
export function pythonLevelFromPyproject(content: string): string | undefined {
  const m =
    /requires-python\s*=\s*["']([^"']+)["']/.exec(content) ??
    /^\s*python\s*=\s*["']([^"']+)["']/m.exec(content);
  if (!m) return undefined;
  const floor = floorFromConstraint(m[1]);
  return floor ? snapToLevels(floor, PYTHON_LEVELS) : undefined;
}
