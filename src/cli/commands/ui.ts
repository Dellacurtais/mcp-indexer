/**
 * `ui` — start the local configuration dashboard and open it in the browser.
 *
 * Listens on 127.0.0.1 only (loopback) so AWS credentials typed into the form
 * never leave the machine, regardless of what IndexerConfig.dashboard.host says.
 */
import { spawn } from 'node:child_process';
import { startDashboardServer } from '../../dashboard/server.js';

export interface UiOpts {
  open?: boolean;
  port?: number;
}

/** Open a URL in the OS default browser (best-effort; never throws). */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? { exe: 'cmd', args: ['/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { exe: 'open', args: [url] }
        : { exe: 'xdg-open', args: [url] };
  try {
    spawn(cmd.exe, cmd.args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* ignore — user can click the printed URL */
  }
}

export async function runUi(opts: UiOpts): Promise<void> {
  const port = opts.port ?? Number(process.env.MCP_INDEX_PORT ?? '7333');
  const { url } = await startDashboardServer({ port });
  if (opts.open !== false) openBrowser(url);

  // Stay alive until SIGINT/SIGTERM.
  const shutdown = (): void => {
    process.stderr.write('\n[code-context] dashboard stopped.\n');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise<never>(() => {});
}
