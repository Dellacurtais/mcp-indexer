/**
 * Daemon discovery / lifecycle for the broker.
 *
 * Each project gets one daemon, recorded in `<root>/.mcp-context/daemon.json`.
 * The stdio shim reads the lock; if the daemon is missing or dead it spawns one
 * detached and waits for it to report healthy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface LockInfo {
  port: number;
  pid: number;
  project: string;
  root: string;
  startedAt: string;
  serverName: string;
}

export function lockPath(root: string): string {
  return path.join(root, '.mcp-context', 'daemon.json');
}

export function readLock(root: string): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath(root), 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

export function writeLock(root: string, info: LockInfo): void {
  const p = lockPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(info, null, 2));
}

export function removeLock(root: string): void {
  try {
    fs.rmSync(lockPath(root), { force: true });
  } catch {
    /* ignore */
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

export async function daemonHealthy(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface EnsureDaemonOptions {
  /** Absolute path to this CLI entry (dist/cli/index.js or src/cli/index.ts under tsx). */
  cliPath: string;
  /** Extra env for the spawned daemon (e.g. MCP_SERVER_NAME, MCP_OUTPUT_CAP_LEVEL). */
  env?: Record<string, string | undefined>;
  noEmbeddings?: boolean;
  startupTimeoutMs?: number;
}

/** Return a live daemon for `root`, spawning one detached if needed. */
export async function ensureDaemon(
  root: string,
  opts: EnsureDaemonOptions,
): Promise<{ baseUrl: string; info: LockInfo }> {
  const existing = readLock(root);
  if (existing && pidAlive(existing.pid) && (await daemonHealthy(existing.port))) {
    return { baseUrl: `http://127.0.0.1:${existing.port}`, info: existing };
  }
  removeLock(root);

  const args = [opts.cliPath, 'context', root, '--daemon'];
  if (opts.noEmbeddings) args.push('--no-embeddings');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...opts.env },
  });
  child.unref();

  const deadline = Date.now() + (opts.startupTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    await delay(250);
    const lk = readLock(root);
    if (lk && pidAlive(lk.pid) && (await daemonHealthy(lk.port))) {
      return { baseUrl: `http://127.0.0.1:${lk.port}`, info: lk };
    }
  }
  throw new Error(`daemon for ${root} did not become healthy in time`);
}
