/**
 * Read / merge / write the global `~/.code-context/.env` file.
 *
 * This is the "stable home for credentials" per config.ts:6-18. The UI manages a
 * KNOWN subset of keys (AWS creds + CODE_CONTEXT_ANALYSIS* + budget) and must
 * preserve any other keys the user or other tooling wrote there (merge, never
 * overwrite the whole file).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mcpDataDir } from '@ctx/shared/utils/config.js';

/** Keys the dashboard manages. Anything else in the file is preserved untouched. */
const MANAGED_KEYS = new Set([
  'CODE_CONTEXT_ANALYSIS',
  'CODE_CONTEXT_ANALYSIS_MODEL',
  'CODE_CONTEXT_ANALYSIS_INFERENCE',
  'CODE_CONTEXT_EXPLORER_PROVIDER',
  'CODE_CONTEXT_EXPLORER_MODEL',
  'CODE_CONTEXT_EXPLORER_INFERENCE',
  'MCP_EXEC',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'MCP_INDEX_BUDGET',
]);

/** Keys whose value must never be echoed back to the browser. */
const SECRET_KEYS = new Set(['AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']);

export interface EnvFile {
  /** Absolute path of the file (the global ~/.code-context/.env unless overridden). */
  path: string;
  /** Raw map of every key present in the file (managed + unmanaged). */
  values: Record<string, string>;
}

/** Parse a .env file into a plain map. Tolerates quotes, comments, blank lines. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip a single matching pair of surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Serialize a map back to .env text, preserving original order + unknown keys. */
export function stringifyEnvFile(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .map(([k, v]) => {
        // quote when the value contains whitespace or a comment marker
        const needsQuote = /\s|#|=/.test(v);
        return `${k}=${needsQuote ? `"${v.replace(/"/g, '\\"')}"` : v}`;
      })
      .join('\n') + '\n'
  );
}

/** Absolute path of the global .env (respects MCP_DATA_DIR override). */
export function globalEnvPath(): string {
  return join(mcpDataDir(), '.env');
}

/** Read the global .env, or return an empty map when it does not exist yet. */
export function readEnvFile(): EnvFile {
  const path = globalEnvPath();
  const values: Record<string, string> = {};
  if (existsSync(path)) {
    Object.assign(values, parseEnvFile(readFileSync(path, 'utf8')));
  }
  // process.env wins per precedence, so surface it for managed keys when the file
  // is empty/missing — otherwise the UI shows "blank" for a working setup.
  for (const k of MANAGED_KEYS) {
    if (values[k] === undefined && process.env[k]) {
      values[k] = process.env[k] as string;
    }
  }
  return { path, values };
}

/** Mask secret values for safe transport to the browser. */
export function maskForBrowser(values: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    masked[k] = SECRET_KEYS.has(k) && v ? '<set>' : v ?? '';
  }
  return masked;
}

/** Merge a partial update into the global .env, preserving unmanaged keys. */
export function writeEnvFile(updates: Record<string, string | undefined>): EnvFile {
  const { path, values } = readEnvFile();
  for (const [k, rawV] of Object.entries(updates)) {
    if (!MANAGED_KEYS.has(k)) continue; // never touch unmanaged keys
    // A masked sentinel ('<set>') from the browser means "leave as-is".
    const v = rawV === undefined || rawV === '' ? '' : rawV;
    if (SECRET_KEYS.has(k) && (v === '<set>' || v === '')) {
      if (v === '<set>') continue; // keep the existing secret
      if (v === '') delete values[k]; // explicit clear
      continue;
    }
    if (v === '') {
      delete values[k];
    } else {
      values[k] = v;
    }
  }
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyEnvFile(values), 'utf8');
  return { path, values };
}

/** Resolve AWS-style credentials from a (possibly partial) env map. */
export function credsFromEnv(
  values: Record<string, string>,
): { region: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string } {
  return {
    region: values.AWS_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    accessKeyId: values.AWS_ACCESS_KEY_ID,
    secretAccessKey: values.AWS_SECRET_ACCESS_KEY,
    sessionToken: values.AWS_SESSION_TOKEN,
  };
}

void homedir; // kept for future override resolution; mcpDataDir is the single source today
