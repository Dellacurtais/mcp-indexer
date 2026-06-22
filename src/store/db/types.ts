import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
export const Database = require('better-sqlite3') as typeof DatabaseConstructor;

export type DB = InstanceType<typeof Database>;

export interface PathAlias {
  prefix: string;
  targets: string[];
}
