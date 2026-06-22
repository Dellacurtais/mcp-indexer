import type { Project } from '@ctx/shared/types.js';
import type { ToolContext } from '../context.js';
import type { AuthContext, McpTool } from '../tool.js';
import { resolveProject } from '../utils.js';

/**
 * Handler variant that receives the already-resolved `project` as its
 * fourth argument, removing the boilerplate
 * `const project = resolveProject(db, args.project_name as string)`
 * that previously appeared in 27+ tool handlers.
 */
export type ProjectToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
  project: Project,
  authCtx?: AuthContext,
) => Promise<string> | string;

/**
 * Wrap a handler so it receives the resolved project. Throws the same
 * "Project not found" error that `resolveProject` does, keeping user-facing
 * messages unchanged.
 */
export function withProject(handler: ProjectToolHandler): McpTool['handler'] {
  return (args, ctx, authCtx) => {
    const project = resolveProject(ctx.db, args.project_name as string);
    return handler(args, ctx, project, authCtx);
  };
}

/**
 * Normalize a file path from AI input to the forward-slash relative form stored
 * in the database. Handles backslashes (Windows), leading `./`, and absolute
 * paths that include the project root prefix.
 */
export function normalizeFilePath(filePath: string, projectRoot?: string): string {
  let p = filePath.replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  if (projectRoot) {
    const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    if (p.startsWith(root)) p = p.slice(root.length);
  }
  return p;
}

/**
 * Render a tool result in either JSON or human-readable text form. Replaces
 * the scattered `const asJson = args.format === 'json'; if (asJson) { ... }`
 * branching that existed in 7+ tools.
 */
export function formatOutput<T>(
  args: Record<string, unknown>,
  data: T,
  renderText: (data: T) => string,
): string {
  return args.format === 'json' ? JSON.stringify(data) : renderText(data);
}
