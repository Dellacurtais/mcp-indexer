/**
 * Single source of truth for path → language id (Monaco-compatible ids).
 *
 * Used by BOTH sides of the LSP plumbing: the renderer (Monaco model
 * language + provider routing) and the backend (document store + per-
 * language backend dispatch). Extracted from MonacoMount's inferLanguage —
 * keep ids aligned with Monaco's registry, since they double as Monaco
 * `language` props.
 */
export function languageIdForPath(path: string): string {
  const base = path.toLowerCase().split(/[\\/]/).pop() ?? '';
  if (base === 'dockerfile') return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop() ?? '' : '';
  switch (ext) {
    case 'ts': case 'cts': case 'mts': return 'typescript';
    case 'tsx': return 'typescript';
    case 'js': case 'cjs': case 'mjs': return 'javascript';
    case 'jsx': return 'javascript';
    case 'json': return 'json';
    case 'md': case 'markdown': return 'markdown';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'less': return 'less';
    case 'html': case 'htm': return 'html';
    case 'vue': return 'vue';
    case 'svelte': return 'svelte';
    case 'xml': return 'xml';
    case 'yaml': case 'yml': return 'yaml';
    case 'toml': return 'toml';
    case 'py': return 'python';
    case 'rb': return 'ruby';
    case 'php': return 'php';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'java': return 'java';
    case 'kt': case 'kts': return 'kotlin';
    case 'swift': return 'swift';
    case 'cs': return 'csharp';
    case 'cpp': case 'cc': case 'cxx': case 'hpp': return 'cpp';
    case 'c': case 'h': return 'c';
    case 'lua': return 'lua';
    case 'dart': return 'dart';
    case 'scala': return 'scala';
    case 'sql': return 'sql';
    case 'sh': case 'bash': return 'shell';
    case 'ps1': return 'powershell';
    case 'dockerfile': return 'dockerfile';
    default: return 'plaintext';
  }
}
