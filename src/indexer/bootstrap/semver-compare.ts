/**
 * Tiny semver comparator. We don't need ranges or pre-release ordering —
 * just `>`, `<`, `==` between two `M.m.p` strings.
 *
 * Pure function, exported for unit testing without I/O.
 *
 * Returns:
 *  - negative when `a < b`
 *  - zero     when `a == b` (or either is unparseable, treated as 0.0.0)
 *  - positive when `a > b`
 */
export function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function parse(v: string): [number, number, number] {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return [0, 0, 0];
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}
