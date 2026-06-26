/**
 * Spawns the `code-context index <root>` CLI as a child process and parses its
 * stderr progress lines into typed events for the SSE stream.
 *
 * Isolation of fault: a crash inside indexing (ONNX/SQLite native errors) never
 * takes down the dashboard server — the child dies, we report the failure.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProgressEvent =
  | { type: 'progress'; phase: string; current?: number; total?: number }
  | { type: 'log'; line: string }
  | { type: 'done'; ok: boolean; code: number | null; message: string };

export interface RunningIndex {
  runId: string;
  child: ChildProcess;
}

/** Resolve the command + args to launch the CLI, whether installed globally or in dev. */
function resolveCli(): { cmd: string; args: string[] } {
  // 1. Prefer the local built entrypoint next to this module (robust in published builds).
  const here = dirname(fileURLToPath(import.meta.url));
  const localEntry = join(here, '..', '..', 'cli', 'index.js');
  if (existsSync(localEntry)) {
    return { cmd: process.execPath, args: [localEntry] };
  }
  // 2. Fallback to a `code-context` on PATH (global install).
  return { cmd: 'code-context', args: [] };
}

/**
 * Index format on stderr (see cli/commands/index-cmd.ts:24 and :43):
 *   "  <phase> <current>/<total>            \r"   (carriage-return progress)
 *   "indexed N/M files (...)"               (final line, \n)
 *   "embedded N/M candidates (...)"         (final line, \n)
 * The regex below matches both the live counter and the final summary.
 */
const PROGRESS_RE =
  /\b(?<phase>indexed|embedding|embedded|indexing)\b\s*(?<cur>\d+)?\s*(?:\/\s*(?<total>\d+))?/i;

/** Parse a chunk of stderr text into ProgressEvent[]. */
export function parseStderrChunk(chunk: string, phaseHint: string): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  // stderr mixes \r-progress and \n-summaries; normalize on either boundary.
  const segments = chunk.split(/\r|\n/);
  for (const seg of segments) {
    const s = seg.trim();
    if (!s) continue;
    const m = s.match(PROGRESS_RE);
    if (m && m.groups) {
      const phase = /embed/i.test(m.groups.phase) ? 'embedding' : 'structural';
      const current = m.groups.cur ? parseInt(m.groups.cur, 10) : undefined;
      const total = m.groups.total ? parseInt(m.groups.total, 10) : undefined;
      events.push({ type: 'progress', phase, current, total });
    } else if (/\bindexed\b|\bembedded\b/i.test(s)) {
      // final summary line that didn't quite match the counter shape
      events.push({ type: 'log', line: s });
    } else {
      events.push({ type: 'log', line: s });
    }
  }
  void phaseHint;
  return events;
}

/** Start an indexing run for `root`. Returns the handle; the caller wires events. */
export function startIndexRun(
  root: string,
  opts: { noEmbeddings?: boolean },
  onEvent: (e: ProgressEvent) => void,
): RunningIndex {
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const { cmd, args } = resolveCli();
  const fullArgs = [...args, 'index', root];
  if (opts.noEmbeddings) fullArgs.push('--no-embeddings');

  let phase = 'structural';
  let lastSummary = '';
  const child = spawn(cmd, fullArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env },
  });

  const stderrBuf: string[] = [];
  child.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8');
    stderrBuf.push(text);
    for (const ev of parseStderrChunk(text, phase)) {
      if (ev.type === 'progress') phase = ev.phase;
      if (ev.type === 'log') lastSummary = ev.line;
      onEvent(ev);
    }
  });
  // stdout is unused by `index`, but drain it to avoid backpressure.
  child.stdout?.on('data', () => {});

  child.on('error', (err) => {
    onEvent({
      type: 'done',
      ok: false,
      code: null,
      message: `failed to start indexing: ${err.message}`,
    });
  });
  child.on('close', (code) => {
    onEvent({
      type: 'done',
      ok: code === 0,
      code,
      message:
        code === 0
          ? lastSummary || 'indexing complete'
          : `indexing failed (exit ${code})`,
    });
  });

  return { runId, child };
}

/** Currently active runs keyed by project id, so only one runs at a time. */
const activeRuns = new Map<number, RunningIndex>();

export function getActiveRun(projectId: number): RunningIndex | undefined {
  return activeRuns.get(projectId);
}

export function setActiveRun(projectId: number, run: RunningIndex | undefined): void {
  if (run) activeRuns.set(projectId, run);
  else activeRuns.delete(projectId);
}
