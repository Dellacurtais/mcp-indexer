/**
 * Per-project DB layer (tiered-hybrid SQLite split).
 *
 * Public surface for resolving, opening, pooling, and federating per-project
 * SQLite databases that live in each project's `.mcp-indexer/` folder. See the
 * plan at ~/.claude/plans/ser-que-seria-melhor-linear-pine.md (§6).
 */
export {
  PROJECT_DB_DIRNAME,
  PROJECT_DB_FILENAME,
  PROJECT_VECTORS_FILENAME,
  centralFallbackDir,
  resolveProjectDbLocation,
  type ProjectDbLocation,
  type ResolveOpts,
} from './paths.js';
export { openRawProjectDb, type OpenProjectDbOpts } from './open.js';
export { initProjectSchema, getProjectSchemaVersion } from './project-schema.js';
export { ProjectDb, type NowFn } from './handle.js';
export { ProjectDbPool, type ProjectDbPoolOpts } from './pool.js';
export {
  ATTACH_BATCH,
  aliasFor,
  withAttachedProjects,
  type AttachTarget,
} from './attach.js';
export { fanOutProjects, attachedDbCap, type FanOutOpts } from './attach-batch.js';
export { ProjectDbUnavailableError, AttachLimitError } from './errors.js';
export { routedFeatureDbPath } from './routed-path.js';
