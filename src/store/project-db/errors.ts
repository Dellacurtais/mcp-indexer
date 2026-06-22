/**
 * Errors for the per-project DB layer (tiered-hybrid SQLite split).
 *
 * Kept tiny and dependency-free so both the main process and worker threads can
 * import them without pulling the rest of the store package.
 */

/** A project's DB file could not be opened/created (unwritable/remote root). */
export class ProjectDbUnavailableError extends Error {
  constructor(
    readonly projectId: number,
    readonly dbPath: string,
    readonly cause?: unknown,
  ) {
    super(`Project DB unavailable for project ${projectId} at ${dbPath}`);
    this.name = 'ProjectDbUnavailableError';
  }
}

/**
 * A federated query asked to ATTACH more project DBs than SQLite allows on a
 * single connection (`SQLITE_MAX_ATTACHED`, default 10). Callers must batch via
 * `fanOutProjects` instead — this guards against a silent overflow.
 */
export class AttachLimitError extends Error {
  constructor(readonly requested: number, readonly cap: number) {
    super(`Cannot ATTACH ${requested} databases at once (cap ${cap}); batch the query`);
    this.name = 'AttachLimitError';
  }
}
