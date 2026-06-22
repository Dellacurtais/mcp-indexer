/**
 * Repository Map generator — Aider-style structural summary.
 *
 * Produces a compact (~2000 token) map of the project: file tree annotated
 * with key symbols, weighted by importance (entry points, high-complexity,
 * hub files with many dependents). Uses a simplified PageRank-like score
 * based on the dependency graph.
 *
 * The agent gets this on turn 1 via `get_repo_map`, eliminating 2-3
 * exploratory turns that would otherwise be spent understanding the codebase.
 */
import type { CodeIndexDB } from '@ctx/store/db.js';
import type { DBFile, DBSymbol } from '@ctx/shared/types.js';

interface FileScore {
  path: string;
  language: string;
  score: number;
  symbols: Array<{ name: string; kind: string; signature: string }>;
  layer: string;
  complexity: string;
  isEntryPoint: boolean;
}

/**
 * Build a repo map for the given project.
 * @param maxTokens Approximate token budget (chars / 4).
 */
export function buildRepoMap(
  db: CodeIndexDB,
  projectId: number,
  maxTokens = 2000,
): string {
  const maxChars = maxTokens * 4;

  // 1. Get all files
  const files = db.listFiles(projectId) as DBFile[];
  if (files.length === 0) return '(empty project)';

  // 2. Compute importance scores
  const scores = computeScores(db, projectId, files);

  // 3. Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  // 4. Build the map text within budget
  const lines: string[] = [];
  lines.push(`# Repository Map (${files.length} files)`);
  lines.push('');

  // Group by directory for readability
  const byDir = new Map<string, FileScore[]>();
  for (const f of scores) {
    const dir = f.path.includes('/') ? f.path.split('/').slice(0, -1).join('/') : '.';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(f);
  }

  // Sort directories by max score of their files
  const sortedDirs = [...byDir.entries()]
    .map(([dir, files]) => ({ dir, files, maxScore: Math.max(...files.map(f => f.score)) }))
    .sort((a, b) => b.maxScore - a.maxScore);

  let charCount = lines.join('\n').length;

  for (const { dir, files: dirFiles } of sortedDirs) {
    const dirLine = `\n## ${dir}/`;
    if (charCount + dirLine.length > maxChars) break;
    lines.push(dirLine);
    charCount += dirLine.length;

    for (const f of dirFiles) {
      const fileName = f.path.split('/').pop() ?? f.path;
      const badges: string[] = [];
      if (f.isEntryPoint) badges.push('entry');
      if (f.complexity === 'high' || f.complexity === 'very-high') badges.push(f.complexity);
      if (f.layer && f.layer !== 'unknown') badges.push(f.layer);
      const badgeStr = badges.length > 0 ? ` [${badges.join(', ')}]` : '';

      const fileLine = `  ${fileName}${badgeStr}`;
      if (charCount + fileLine.length > maxChars) break;
      lines.push(fileLine);
      charCount += fileLine.length;

      // Add top 3 symbols per file
      for (const sym of f.symbols.slice(0, 3)) {
        const sigShort = sym.signature.length > 80 ? sym.signature.slice(0, 80) + '...' : sym.signature;
        const symLine = `    ${sym.kind} ${sym.name}: ${sigShort}`;
        if (charCount + symLine.length > maxChars) break;
        lines.push(symLine);
        charCount += symLine.length;
      }
    }
  }

  return lines.join('\n');
}

/**
 * Simplified PageRank-like scoring based on dependency graph.
 *
 * Score components:
 *   - Dependent count (files that import this file) — strongest signal
 *   - Entry point flag (main, index, app)
 *   - Complexity (high/very-high files are more important for understanding)
 *   - Symbol count (files with many exports are architectural hubs)
 */
function computeScores(
  db: CodeIndexDB,
  projectId: number,
  files: DBFile[]
): FileScore[] {
  const results: FileScore[] = [];

  for (const file of files) {
    let score = 0;

    // Dependents score (PageRank proxy)
    const dependents = db.getDependents(projectId, file.id);
    score += dependents.length * 3;

    // Entry point bonus
    if (file.is_entry_point) score += 10;

    // Complexity bonus
    if (file.complexity === 'very-high') score += 5;
    else if (file.complexity === 'high') score += 3;
    else if (file.complexity === 'medium') score += 1;

    // Symbol count (architectural richness)
    const symbols = db.getSymbolsByFile(projectId, file.path);
    const exportedSymbols = symbols.filter(s =>
      ['function', 'class', 'interface', 'method', 'type'].includes(s.kind)
    );
    score += Math.min(exportedSymbols.length, 10); // Cap at 10

    // Layer bonuses
    if (file.layer === 'business') score += 2;
    if (file.layer === 'infrastructure') score += 1;

    results.push({
      path: file.path,
      language: file.language,
      score,
      symbols: exportedSymbols.slice(0, 5).map(s => ({
        name: s.name,
        kind: s.kind,
        signature: s.signature ?? s.name,
      })),
      layer: file.layer,
      complexity: file.complexity,
      isEntryPoint: !!file.is_entry_point,
    });
  }

  return results;
}
