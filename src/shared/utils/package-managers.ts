/**
 * Per-project package-manager preference (Node/Python) — single source of
 * parsing + writing. Persisted in `project_runtime_config.package_managers`
 * (JSON, migration 169). Drives the dependency assistant in the project
 * settings (install/update) and overrides the runner's lockfile auto-detect.
 *
 * Value = the manager id ('npm'|'yarn'|'pnpm'|'bun' for Node; 'pip'|'poetry'
 * for Python). Missing key or NULL = "auto" (the runner picks it from the
 * lockfile/manifest, the default behaviour). PHP is fixed (composer) so it has
 * no key here. No DB deps — reused by the UI and the runner backend.
 */

export type PackageManagerKey = 'node' | 'python';
export type PackageManagers = Partial<Record<PackageManagerKey, string>>;

const KEYS: readonly PackageManagerKey[] = ['node', 'python'];

/** JSON → map, tolerant of corruption/invalid shape (always returns an object). */
export function parsePackageManagers(json: string | null | undefined): PackageManagers {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as unknown;
    if (!obj || typeof obj !== 'object') return {};
    const rec = obj as Record<string, unknown>;
    const out: PackageManagers = {};
    for (const k of KEYS) {
      const v = rec[k];
      if (typeof v === 'string' && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** The chosen manager for a language, or undefined (= auto-detect). */
export function readPackageManager(json: string | null | undefined, key: PackageManagerKey): string | undefined {
  return parsePackageManagers(json)[key];
}

/**
 * Merge the choice into the JSON and return the updated JSON, preserving the
 * other key. A falsy/`'auto'` id REMOVES the key (back to lockfile detection).
 */
export function writePackageManager(
  json: string | null | undefined,
  key: PackageManagerKey,
  id: string | null | undefined,
): string {
  const next = parsePackageManagers(json);
  if (!id || id === 'auto') delete next[key];
  else next[key] = id;
  return JSON.stringify(next);
}
