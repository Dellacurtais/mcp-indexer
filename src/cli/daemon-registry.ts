/**
 * Daemon discovery / lifecycle for the broker.
 *
 * Each project gets one daemon, recorded in `<root>/.mcp-context/daemon.json`.
 * The stdio shim reads the lock; if the daemon is missing or dead it acquires an
 * exclusive spawn lock and starts one detached, then waits for it to report
 * healthy. The spawn lock + health-identity check prevent two editors from
 * cold-starting two daemons for the same repo.
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

export interface HealthInfo {
  ok: boolean;
  server?: string;
  project?: string;
  root?: string;
  tools?: number;
}

const ctxDir = (root: string): string => path.join(root, '.mcp-context');
export function lockPath(root: string): string {
  return path.join(ctxDir(root), 'daemon.json');
}
const spawnLockPath = (root: string): string => path.join(ctxDir(root), 'spawn.lock');

function sameRoot(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const norm = (p: string): string => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export function readLock(root: string): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath(root), 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

/** Atomic write (temp + rename) so a concurrent reader never sees a half file. */
export function writeLock(root: string, info: LockInfo): void {
  const p = lockPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
  fs.renameSync(tmp, p);
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

/** GET /health and return its identity body, or null if unreachable/not-ok. */
export async function daemonHealth(port: number, timeoutMs = 800): Promise<HealthInfo | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as HealthInfo;
    return body && body.ok ? body : null;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A lock is "live" only if its pid is alive AND /health confirms it owns this root. */
export async function liveDaemon(root: string): Promise<{ baseUrl: string; info: LockInfo } | null> {
  const lk = readLock(root);
  if (!lk || !pidAlive(lk.pid)) return null;
  const h = await daemonHealth(lk.port);
  if (h && sameRoot(h.root, root)) return { baseUrl: `http://127.0.0.1:${lk.port}`, info: lk };
  return null;
}

async function pollForDaemon(
  root: string,
  timeoutMs: number,
): Promise<{ baseUrl: string; info: LockInfo } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(250);
    const live = await liveDaemon(root);
    if (live) return live;
  }
  return null;
}

export interface EnsureDaemonOptions {
  /** Absolute path to this CLI entry (dist/cli/index.js, or src/cli/index.ts under tsx). */
  cliPath: string;
  env?: Record<string, string | undefined>;
  noEmbeddings?: boolean;
  startupTimeoutMs?: number;
}

/** Return a live daemon for `root`, spawning one detached if needed (race-safe). */
export async function ensureDaemon(
  root: string,
  opts: EnsureDaemonOptions,
): Promise<{ baseUrl: string; info: LockInfo }> {
  const timeout = opts.startupTimeoutMs ?? 60_000;

  const live = await liveDaemon(root);
  if (live) return live;

  // Win the exclusive right to spawn (O_EXCL). Losers poll for the winner's daemon.
  fs.mkdirSync(ctxDir(root), { recursive: true });
  let owner = false;
  try {
    const fd = fs.openSync(spawnLockPath(root), 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    owner = true;
  } catch {
    owner = false;
  }

  if (!owner) {
    const r = await pollForDaemon(root, timeout);
    if (r) return r;
    // Winner crashed without producing a daemon — clear the stale spawn lock and take over.
    try {
      fs.rmSync(spawnLockPath(root), { force: true });
    } catch {
      /* ignore */
    }
    const retry = await liveDaemon(root);
    if (retry) return retry;
  }

  try {
    removeLock(root); // clear a dead lock before our daemon writes a fresh one
    // Forward execArgv so a tsx (.ts) entrypoint re-spawns under the same loader;
    // for a compiled dist (.js) entry execArgv is empty, so this is a no-op there.
    const args = [...process.execArgv, opts.cliPath, 'context', root, '--daemon'];
    if (opts.noEmbeddings) args.push('--no-embeddings');
    // Capture the detached daemon's stdout+stderr to a log so a silent startup
    // crash is diagnosable (otherwise ensureDaemon just times out blind).
    const logFd = fs.openSync(path.join(ctxDir(root), 'daemon.log'), 'a');
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ...opts.env },
    });
    child.unref();

    const r = await pollForDaemon(root, timeout);
    if (r) return r;
    throw new Error(`daemon for ${root} did not become healthy within ${Math.round(timeout / 1000)}s`);
  } finally {
    if (owner) {
      try {
        fs.rmSync(spawnLockPath(root), { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
