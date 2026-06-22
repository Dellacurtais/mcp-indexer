/**
 * Canonical vector-store namespaces.
 *
 * Code is isolated PER PROJECT; docs PER COLLECTION (docs are cross-project by
 * design — a collection like "unity-docs" is shared across game projects, so
 * the collection, not the project, is the isolation axis).
 *
 * Each `VectorStore` backend maps the namespace string to its native isolation
 * primitive: a Pinecone namespace, a Qdrant collection, a sqlite-vec column, or
 * a Cloudflare/OpenSearch metadata filter. Keeping the mapping in ONE place
 * means the upsert side and the search side can never drift.
 */

/**
 * Namespace for a project's code/symbol/snapshot vectors.
 *
 * Keyed by project NAME (not id) on purpose: `project_name` is already the
 * tenant discriminator stored in every vector's metadata, so this is the only
 * key derivable both at upsert/search time AND when backfilling legacy rows
 * that never recorded a project id.
 */
export function codeNamespace(projectName: string): string {
  return `code:${projectName}`;
}

/** Namespace for a documentation collection's chunk vectors. */
export function docNamespace(collectionId: number | string): string {
  return `docs:c${collectionId}`;
}

export function isCodeNamespace(ns: string): boolean {
  return ns.startsWith('code:');
}

export function isDocNamespace(ns: string): boolean {
  return ns.startsWith('docs:');
}

/**
 * Sanitize a namespace into a token safe for backends that name a physical
 * object after it (e.g. a Qdrant collection): only [A-Za-z0-9_].
 */
export function namespaceToken(ns: string): string {
  return ns.replace(/[^A-Za-z0-9]+/g, '_');
}
