import type { ToolContext } from './context.js';

/**
 * Minimal auth context. The upstream IDE carried a rich per-request auth object
 * (scopes/subject/audit) for its authenticated HTTP transport. code-context
 * serves a local loopback daemon without auth, so this is a permissive stub kept
 * only for handler-signature compatibility; it is always `undefined` at runtime.
 */
export interface AuthContext {
  scopes?: string[];
  subject?: string;
  [key: string]: unknown;
}

export interface McpToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface McpTool {
  name: string;
  description: string;
  /**
   * Scope required to call this tool. Defaults to 'mcp:write' when absent
   * (fail-safe: authors must opt into broader exposure). The scope registry
   * is built automatically from this field — no parallel map to maintain.
   */
  scope?: string;
  inputSchema: McpToolInputSchema;
  /**
   * Tool handler. The third argument carries per-request authentication
   * context when the HTTP transport is used with auth enabled. It is
   * `undefined` for stdio transport and for HTTP without auth.
   */
  handler(
    args: Record<string, unknown>,
    ctx: ToolContext,
    authCtx?: AuthContext,
  ): Promise<string> | string;
}

/**
 * Identity helper for defining a tool with full type inference.
 * Drop a `defineTool({ ... })` object in any file under tools/ and
 * re-export it from tools/index.ts to plug a new tool into the server.
 */
export function defineTool(tool: McpTool): McpTool {
  return tool;
}
