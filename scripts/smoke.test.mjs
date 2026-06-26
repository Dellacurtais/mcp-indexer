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
  // Clear any host explorer/exec config so `explore` degrades deterministically.
  const env = {
    ...process.env,
    MCP_DATA_DIR: dataDir,
    MCP_SERVER_NAME: 'code-context',
    __fixture: repo,
    CODE_CONTEXT_ANALYSIS: '',
    CODE_CONTEXT_EXPLORER_PROVIDER: '',
    CODE_CONTEXT_EXPLORER_MODEL: '',
    MCP_EXEC: '',
  };
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  execFileSync('node', [CLI, 'index', repo, '--no-embeddings'], { env, stdio: 'pipe' });

  await withServer(env, async (client) => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.equal(names.length, 12, `expected 12 core tools, got ${names.length}: ${names.join(',')}`);
    for (const tool of ['pack_context', 'search', 'get_file_skeleton', 'read_file', 'reindex', 'explore']) {
      assert.ok(names.includes(tool), `missing core tool ${tool}`);
    }
    assert.ok(!names.includes('exec_command'), 'exec must be hidden by default');

    const sk = await client.callTool({ name: 'get_file_skeleton', arguments: { file_path: 'src/auth.service.ts' } });
    const skText = sk.content?.[0]?.text ?? '';
    assert.match(skText, /AuthService/, 'skeleton mentions AuthService');
    assert.match(skText, /login/, 'skeleton lists login');

    const sr = await client.callTool({ name: 'search', arguments: { query: 'authentication login' } });
    assert.match(sr.content?.[0]?.text ?? '', /auth\.service\.ts/, 'search finds auth.service.ts');

    // explore is advertised and degrades gracefully when no model is configured.
    const ex = await client.callTool({ name: 'explore', arguments: { task: 'where is login handled' } });
    assert.match(ex.content?.[0]?.text ?? '', /no explorer model configured|not connected/, 'explore degrades gracefully');
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
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(names.length >= 20, `full surface should expose >=20 tools, got ${names.length}`);
    // full = full READ-ONLY surface, but exec stays opt-in (not auto-enabled).
    assert.ok(!names.includes('exec_command'), 'MCP_TOOLS=full must NOT auto-enable exec');
  });
});

test('exec is opt-in and ALWAYS additive (never replaces read-only)', async (t) => {
  const repo = fixture();
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-smoke-data3-'));
  const base = { ...process.env, MCP_DATA_DIR: dataDir, __fixture: repo };
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
  execFileSync('node', [CLI, 'index', repo, '--no-embeddings'], { env: base, stdio: 'pipe' });

  // MCP_EXEC=1 → exec present AND every read-only core tool still present.
  await withServer({ ...base, MCP_EXEC: '1' }, async (client) => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes('exec_command'), 'exec present when MCP_EXEC=1');
    assert.ok(names.includes('search') && names.includes('read_file'), 'read-only preserved (additive)');
    const r = await client.callTool({ name: 'exec_command', arguments: { cmd: 'echo hi-smoke' } });
    assert.match(r.content?.[0]?.text ?? '', /hi-smoke/, 'exec_command runs a real command');
  });

  // The trap: MCP_TOOLS=exec_command must NOT collapse to an exec-only surface.
  await withServer({ ...base, MCP_TOOLS: 'exec_command' }, async (client) => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes('search'), 'read-only preserved with MCP_TOOLS=exec_command');
    assert.ok(names.includes('exec_command'), 'exec present');
  });
});
