/**
 * End-to-end smoke test (node:test, no extra deps): index a tiny fixture, serve it
 * over MCP, and exercise the core tools. Run with `pnpm test` (builds first).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-smoke-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'auth.service.ts'),
    'export class AuthService {\n  login(name: string){ return { id: 1, name }; }\n  logout(){ return true; }\n}\n',
  );
  writeFileSync(
    join(dir, 'src', 'main.ts'),
    'import { AuthService } from "./auth.service";\nexport function boot(){ return new AuthService(); }\n',
  );
  return dir;
}

async function withServer(env, fn) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI, 'serve', env.__fixture, '--no-embeddings', '--no-watch'],
    env,
  });
  const client = new Client({ name: 'smoke', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test('index + serve + core tools', async (t) => {
  const repo = fixture();
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-smoke-data-'));
  const env = { ...process.env, MCP_DATA_DIR: dataDir, MCP_SERVER_NAME: 'code-context', __fixture: repo };
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  execFileSync('node', [CLI, 'index', repo, '--no-embeddings'], { env, stdio: 'pipe' });

  await withServer(env, async (client) => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.equal(names.length, 11, `expected 11 core tools, got ${names.length}: ${names.join(',')}`);
    for (const tool of ['pack_context', 'search', 'get_file_skeleton', 'read_file', 'reindex']) {
      assert.ok(names.includes(tool), `missing core tool ${tool}`);
    }

    const sk = await client.callTool({ name: 'get_file_skeleton', arguments: { file_path: 'src/auth.service.ts' } });
    const skText = sk.content?.[0]?.text ?? '';
    assert.match(skText, /AuthService/, 'skeleton mentions AuthService');
    assert.match(skText, /login/, 'skeleton lists login');

    const sr = await client.callTool({ name: 'search', arguments: { query: 'authentication login' } });
    assert.match(sr.content?.[0]?.text ?? '', /auth\.service\.ts/, 'search finds auth.service.ts');
  });
});

test('MCP_TOOLS=full exposes the whole read-only surface', async (t) => {
  const repo = fixture();
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-smoke-data2-'));
  const env = { ...process.env, MCP_DATA_DIR: dataDir, MCP_TOOLS: 'full', __fixture: repo };
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  execFileSync('node', [CLI, 'index', repo, '--no-embeddings'], { env, stdio: 'pipe' });
  await withServer(env, async (client) => {
    const count = (await client.listTools()).tools.length;
    assert.ok(count >= 20, `full surface should expose >=20 tools, got ${count}`);
  });
});
