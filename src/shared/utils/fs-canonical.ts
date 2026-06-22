/**
 * Canonicalizador único de paths (W3) — a "chave de arquivo" compartilhada entre o
 * backend LSP, o handle do server e o renderer. Sem isto, o `didOpen` registra o doc
 * num caminho (`D:/proj/x.php`) e a completion consulta noutro (`d:/proj/x.php`), e o
 * intelephense (que indexa por URI) "não conhece" o arquivo → completion vazia. Causa
 * raiz comum do P2 em Windows.
 *
 * Forma canônica: forward slashes, drive Windows em LOWERCASE, sem trailing slash.
 */
import { isAbsolute, join } from 'node:path';

export function canonicalAbs(p: string): string {
  let s = p.replace(/\\/g, '/');
  // drive Windows → lowercase (D:/ → d:/)
  s = s.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  // sem trailing slash (preserva "/" raiz POSIX e "d:/" raiz de drive)
  if (s.length > 1 && !/^[a-z]:\/$/.test(s)) s = s.replace(/\/+$/, '');
  return s;
}

export function relToAbsCanonical(root: string, rel: string): string {
  const r = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  return canonicalAbs(isAbsolute(r) ? r : join(root, r));
}

export function absToRelCanonical(root: string, abs: string): string | null {
  const a = canonicalAbs(abs);
  const r = canonicalAbs(root);
  if (a.toLowerCase() === r.toLowerCase()) return '';
  if (!a.toLowerCase().startsWith(r.toLowerCase() + '/')) return null;
  return a.slice(r.length + 1);
}
