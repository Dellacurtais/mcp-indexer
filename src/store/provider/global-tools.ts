import type { Database as DB } from 'better-sqlite3';

/** All globally disabled tool names. */
export function listDisabled(db: DB): string[] {
  const rows = db
    .prepare('SELECT tool_name FROM disabled_tools_global ORDER BY tool_name')
    .all() as { tool_name: string }[];
  return rows.map((r) => r.tool_name);
}

/** Toggle a tool's global disabled state. */
export function setDisabled(
  db: DB,
  toolName: string,
  disabled: boolean,
  meta?: { tier: string; source: string },
): void {
  if (disabled) {
    db
      .prepare(
        `INSERT OR IGNORE INTO disabled_tools_global (tool_name, tier, source)
         VALUES (?, ?, ?)`,
      )
      .run(toolName, meta?.tier ?? 'bootstrap', meta?.source ?? 'native');
  } else {
    db.prepare('DELETE FROM disabled_tools_global WHERE tool_name = ?').run(toolName);
  }
}

/** Batch toggle global disabled tools. */
export function bulkSetDisabled(
  db: DB,
  tools: Array<{ tool_name: string; disabled: boolean; tier?: string; source?: string }>,
): void {
  const tx = db.transaction(() => {
    for (const t of tools) {
      setDisabled(db, t.tool_name, t.disabled, {
        tier: t.tier ?? 'bootstrap',
        source: t.source ?? 'native',
      });
    }
  });
  tx();
}
