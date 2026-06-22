/**
 * Content hashing shared by the scanner and the per-file pipeline.
 * Lives in its own module so process-file can re-verify a lazily-read
 * file without importing the scanner (would be an import cycle).
 */
import { createHash } from 'node:crypto';

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function countLines(content: string): number {
  return content.split('\n').length;
}
