/**
 * exec_command / write_stdin / list_sessions — OPT-IN persistent shell sessions.
 *
 * Vendored + trimmed from the upstream agent's exec-command tool (the OpenAI
 * Codex `unified_exec` port). This BREAKS the read-only contract, so it is
 * disabled by default and only ADDED ON TOP of the read-only tools (never an
 * exec-only surface) — see resolveAllowlist/execEnabled in shaping.ts. Enable
 * with MCP_EXEC=1 (or the dashboard toggle).
 *
 *   exec_command: spawn a shell command, yield after `yield_time_ms`, return
 *                 what it emitted + a session_id. Drive a live session with
 *                 write_stdin (REPLs, scaffolders, etc.).
 *   write_stdin:  push bytes into a session's stdin (or empty string to poll).
 *   list_sessions: snapshot the live session registry.
 *
 * Working directory is scoped to the served project's root (relative workdir
 * resolved against it; escaping the root is rejected).
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve as resolvePath, relative as relativePath, isAbsolute } from 'node:path';
import { defineTool, type McpTool } from '../tool.js';
import type { ToolContext } from '../context.js';
import { resolveProject } from '../utils.js';

// ─── Tunables ──────────────────────────────────────────────────────
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_YIELD_MS = 250;
const MAX_YIELD_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const HARD_MAX_OUTPUT_CHARS = 200_000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_OPEN_SESSIONS = 16;

type Status = 'running' | 'exited';

interface NodePtyModule {
  spawn: (
    file: string,
    args: string[] | string,
    options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: NodeJS.ProcessEnv; useConpty?: boolean },
  ) => NodePtyProcess;
}
interface NodePtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

interface SessionRecord {
  id: string;
  cmd: string;
  cwd: string;
  mode: 'pipe' | 'pty';
  proc: ChildProcess | NodePtyProcess;
  status: Status;
  exitCode: number | null;
  pending: string;
  truncated: boolean;
  startedAtMs: number;
  lastTouchMs: number;
  exitedPromise: Promise<void>;
  markExited: (code: number | null) => void;
  dispose: (reason: string) => void;
}

const sessions = new Map<string, SessionRecord>();
let cachedPty: NodePtyModule | null | undefined = undefined;

async function loadNodePty(): Promise<NodePtyModule | null> {
  if (cachedPty !== undefined) return cachedPty;
  try {
    const specifier = 'node-pty';
    cachedPty = (await import(/* @vite-ignore */ specifier)) as NodePtyModule;
  } catch {
    cachedPty = null;
  }
  return cachedPty;
}

const nowMs = (): number => Date.now();
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function reapIdleSessions(): void {
  const cutoff = nowMs() - SESSION_TTL_MS;
  for (const rec of sessions.values()) {
    if (rec.lastTouchMs < cutoff) rec.dispose('idle-ttl');
  }
}

function enforceMaxOpen(): void {
  if (sessions.size <= MAX_OPEN_SESSIONS) return;
  const byIdle = (): SessionRecord[] => [...sessions.values()].sort((a, b) => a.lastTouchMs - b.lastTouchMs);
  for (const rec of byIdle()) {
    if (sessions.size <= MAX_OPEN_SESSIONS) break;
    if (rec.status === 'exited') rec.dispose('max-open-evict-exited');
  }
  while (sessions.size > MAX_OPEN_SESSIONS) {
    const oldest = byIdle()[0];
    if (!oldest) break;
    oldest.dispose('max-open-evict-running');
  }
}

function appendOutput(rec: SessionRecord, chunk: string, maxChars: number): void {
  if (!chunk) return;
  rec.pending += chunk;
  if (rec.pending.length > maxChars) {
    rec.pending = rec.pending.slice(rec.pending.length - maxChars);
    rec.truncated = true;
  }
}

function drainPending(rec: SessionRecord): { output: string; truncated: boolean } {
  const output = rec.pending;
  const truncated = rec.truncated;
  rec.pending = '';
  rec.truncated = false;
  return { output, truncated };
}

const clampYield = (raw: unknown, fallback: number): number => {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.min(Math.max(0, n), MAX_YIELD_MS);
};
const clampMaxChars = (raw: unknown): number => {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_MAX_OUTPUT_CHARS;
  return Math.min(Math.max(1_000, n), HARD_MAX_OUTPUT_CHARS);
};

/** Resolve the served project's root from the project_name arg (cwd anchor). */
function projectRoot(ctx: ToolContext, args: Record<string, unknown>): string {
  const project = resolveProject(ctx.db, String(args.project_name ?? ''));
  return project.root_path;
}

/** workdir scoped to the project root; relative resolves against it, escapes rejected. */
function resolveWorkdir(root: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return root;
  const abs = isAbsolute(raw) ? raw : resolvePath(root, raw);
  const rel = relativePath(root, abs);
  if (rel === '') return abs;
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('workdir must be inside the project root');
  }
  return abs;
}

function describeResult(rec: SessionRecord, drained: { output: string; truncated: boolean }): string {
  const header = [
    `session_id=${rec.id}`,
    `status=${rec.status}`,
    rec.status === 'exited' ? `exit=${rec.exitCode ?? 'signal'}` : null,
    drained.truncated ? 'output_truncated=true' : null,
  ]
    .filter(Boolean)
    .join(' ');
  return `${header}\n\n${drained.output || '(no new output)'}`;
}

/** Strip dev-only env vars that leak from a tsx/Electron parent into shells. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MCP_DEV_HTTP;
  return env;
}

async function spawnSession(opts: {
  cmd: string;
  cwd: string;
  mode: 'pipe' | 'pty';
  cols: number;
  rows: number;
  maxChars: number;
}): Promise<SessionRecord> {
  const env = cleanEnv();
  const id = randomUUID().slice(0, 8);
  const isWindows = process.platform === 'win32';
  let proc: ChildProcess | NodePtyProcess;
  let resolveExit!: () => void;
  const exitedPromise = new Promise<void>((res) => { resolveExit = res; });

  if (opts.mode === 'pty') {
    const pty = await loadNodePty();
    if (!pty) {
      throw new Error(
        'exec_command(tty=true) needs node-pty.\n  Install:  npm install node-pty\n' +
          '  Or call again with tty=false (default) — pipe mode works for most REPLs.',
      );
    }
    const isElectron = !!process.versions.electron;
    proc = pty.spawn(
      isWindows ? 'cmd.exe' : '/bin/sh',
      isWindows ? ['/d', '/s', '/c', opts.cmd] : ['-c', opts.cmd],
      { name: 'xterm-color', cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env, ...(isWindows && isElectron ? { useConpty: false } : {}) },
    );
  } else {
    proc = nodeSpawn(
      isWindows ? 'cmd.exe' : '/bin/sh',
      isWindows ? ['/d', '/s', '/c', opts.cmd] : ['-c', opts.cmd],
      { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  }

  const rec: SessionRecord = {
    id,
    cmd: opts.cmd,
    cwd: opts.cwd,
    mode: opts.mode,
    proc,
    status: 'running',
    exitCode: null,
    pending: '',
    truncated: false,
    startedAtMs: nowMs(),
    lastTouchMs: nowMs(),
    exitedPromise,
    markExited: (code) => {
      rec.status = 'exited';
      rec.exitCode = code;
      resolveExit();
    },
    dispose: () => {
      try {
        if (opts.mode === 'pty') (proc as NodePtyProcess).kill();
        else (proc as ChildProcess).kill('SIGTERM');
      } catch {
        /* ignore */
      }
      if (rec.status === 'running') rec.markExited(null);
      sessions.delete(id);
    },
  };

  if (opts.mode === 'pty') {
    const p = proc as NodePtyProcess;
    p.onData((data) => appendOutput(rec, data, opts.maxChars));
    p.onExit(({ exitCode }) => rec.markExited(exitCode));
  } else {
    const c = proc as ChildProcess;
    c.stdout?.on('data', (chunk: Buffer | string) => appendOutput(rec, chunk.toString(), opts.maxChars));
    c.stderr?.on('data', (chunk: Buffer | string) => appendOutput(rec, chunk.toString(), opts.maxChars));
    c.on('exit', (code, signal) => rec.markExited(code ?? (signal ? -1 : null)));
    c.on('error', (e) => {
      appendOutput(rec, `\n[spawn-error] ${e.message}\n`, opts.maxChars);
      rec.markExited(-1);
    });
  }

  sessions.set(id, rec);
  enforceMaxOpen();
  return rec;
}

function writeToSession(rec: SessionRecord, chars: string): void {
  if (!chars) return;
  if (rec.mode === 'pty') {
    (rec.proc as NodePtyProcess).write(chars);
  } else {
    const stdin = (rec.proc as ChildProcess).stdin;
    if (stdin && !stdin.destroyed) stdin.write(chars);
  }
}

async function awaitYield(rec: SessionRecord, yieldMs: number): Promise<void> {
  if (yieldMs <= 0) return;
  await Promise.race([rec.exitedPromise, new Promise<void>((res) => setTimeout(res, yieldMs))]);
}

function formatAgeMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`;
}

function snapshotLines(): string {
  const now = nowMs();
  const snap = [...sessions.values()].sort((a, b) => a.startedAtMs - b.startedAtMs);
  if (snap.length === 0) return '';
  return snap
    .map((s) => {
      const cmd = s.cmd.length > 60 ? s.cmd.slice(0, 57) + '...' : s.cmd;
      return `${s.id} | ${s.status} | ${s.mode} | age ${formatAgeMs(now - s.startedAtMs)} | idle ${formatAgeMs(now - s.lastTouchMs)} | ${cmd}`;
    })
    .join('\n');
}

// ─── Tools ─────────────────────────────────────────────────────────

const EXEC_DESC =
  'Run a shell command in the project root as a PERSISTENT session and return what it emits within ' +
  '`yield_time_ms`. If still running, you get a `session_id` to drive with `write_stdin` (REPLs, ' +
  'scaffolders, interactive CLIs). For a one-shot command just read the output and let it exit.\n' +
  'NOTE: this tool executes real system commands (opt-in, MCP_EXEC=1); it runs alongside the ' +
  'read-only retrieval tools. Use only in trusted projects.\n' +
  `Defaults: yield_time_ms=${DEFAULT_EXEC_YIELD_MS}, max_output_tokens=${DEFAULT_MAX_OUTPUT_CHARS}, tty=false.`;

const execCommand = defineTool({
  name: 'exec_command',
  description: EXEC_DESC,
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      cmd: { type: 'string', description: 'Shell command line (/bin/sh -c, or cmd.exe /c on Windows).' },
      workdir: { type: 'string', description: 'Working dir; relative resolves against the project root. Default: project root.' },
      tty: { type: 'boolean', description: 'Force a real pty (node-pty). Only when the command gates on isatty(). Default false.' },
      yield_time_ms: { type: 'number', description: `Wait for output before returning. Default ${DEFAULT_EXEC_YIELD_MS}, max ${MAX_YIELD_MS}.` },
      max_output_tokens: { type: 'number', description: `Cap on accumulated output chars. Default ${DEFAULT_MAX_OUTPUT_CHARS}.` },
      cols: { type: 'number', description: 'TTY columns (pty mode). Default 120.' },
      rows: { type: 'number', description: 'TTY rows (pty mode). Default 30.' },
    },
    required: ['cmd'],
  },
  handler: async (args, ctx) => {
    reapIdleSessions();
    const cmd = String(args.cmd ?? '').trim();
    if (!cmd) return 'exec_command: cmd cannot be empty';
    let cwd: string;
    try {
      cwd = resolveWorkdir(projectRoot(ctx, args), args.workdir);
    } catch (e) {
      return `exec_command: ${errMsg(e)}`;
    }
    const mode: 'pipe' | 'pty' = args.tty === true ? 'pty' : 'pipe';
    const yieldMs = clampYield(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS);
    const maxChars = clampMaxChars(args.max_output_tokens);
    const cols = typeof args.cols === 'number' && Number.isFinite(args.cols) ? (args.cols as number) : 120;
    const rows = typeof args.rows === 'number' && Number.isFinite(args.rows) ? (args.rows as number) : 30;

    let rec: SessionRecord;
    try {
      rec = await spawnSession({ cmd, cwd, mode, cols, rows, maxChars });
    } catch (e) {
      return `exec_command: spawn failed — ${errMsg(e)}`;
    }
    await awaitYield(rec, yieldMs);
    rec.lastTouchMs = nowMs();
    const drained = drainPending(rec);
    if (rec.status === 'exited') sessions.delete(rec.id);
    return describeResult(rec, drained);
  },
});

const writeStdin = defineTool({
  name: 'write_stdin',
  description:
    "Send bytes to an exec_command session's stdin, then yield briefly for new output. Use chars=\"\" " +
    'to poll a live session. No newline is auto-appended — include \\n for line-buffered REPLs. A session ' +
    'that exited cannot be reopened.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Session id from a prior exec_command.' },
      chars: { type: 'string', description: 'Bytes to write (no auto newline). Empty = poll.' },
      yield_time_ms: { type: 'number', description: `Wait after writing. Default ${DEFAULT_WRITE_YIELD_MS}, max ${MAX_YIELD_MS}.` },
    },
    required: ['session_id'],
  },
  handler: async (args) => {
    reapIdleSessions();
    const id = String(args.session_id ?? '').trim();
    if (!id) return 'write_stdin: session_id is required';
    const rec = sessions.get(id);
    if (!rec) {
      const active = snapshotLines();
      return (
        `write_stdin: session '${id}' is not active (exited / reaped / never existed). ` +
        `A session that exited cannot be reopened — spawn a fresh one with exec_command.\n` +
        (active ? `Active sessions:\n${active}` : '(no active sessions)')
      );
    }
    const chars = typeof args.chars === 'string' ? args.chars : '';
    const yieldMs = clampYield(args.yield_time_ms, DEFAULT_WRITE_YIELD_MS);
    if (chars && rec.status === 'running') {
      try {
        writeToSession(rec, chars);
      } catch (e) {
        return `write_stdin: write failed — ${errMsg(e)}`;
      }
    }
    await awaitYield(rec, yieldMs);
    rec.lastTouchMs = nowMs();
    const drained = drainPending(rec);
    if (rec.status === 'exited') sessions.delete(rec.id);
    return describeResult(rec, drained);
  },
});

const listSessions = defineTool({
  name: 'list_sessions',
  description:
    'List active exec_command sessions (id, status, age, idle). Use BEFORE write_stdin to confirm a ' +
    'session still exists. Returns "(no active sessions)" when empty.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    reapIdleSessions();
    const lines = snapshotLines();
    if (!lines) return '(no active sessions; spawn one with exec_command first)';
    return (
      'Active sessions:\n<id> | <status> | <mode> | <age> | <idle> | <cmd>\n' + lines
    );
  },
});

/** Kill all live sessions — called from the server shutdown path. */
export function disposeAllSessions(): void {
  for (const rec of sessions.values()) rec.dispose('shutdown');
  sessions.clear();
}

export const __testing = { sessions, reapIdleSessions, disposeAllSessions };

export const execTools: McpTool[] = [execCommand, writeStdin, listSessions];
