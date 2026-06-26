// code-context dashboard — vanilla JS SPA (no framework, no build step).
// Talks to the local Hono API. Tab routing via location.hash.
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const api = (p, opts) => fetch(p, opts).then((r) => r.json());

// ─── tab routing ──────────────────────────────────────────────────────────────
function activateTab(tab) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${tab}`));
  if (tab === 'projects') loadProjects();
  if (tab === 'config') loadConfig();
  if (tab === 'search') populateProjectSelect();
}
window.addEventListener('hashchange', () => activateTab(currentTab()));
function currentTab() {
  const t = (location.hash || '#projects').slice(1);
  return ['projects', 'config', 'search'].includes(t) ? t : 'projects';
}

// ─── projects ─────────────────────────────────────────────────────────────────
async function loadProjects() {
  const list = $('#projects-list');
  list.innerHTML = '<p class="muted">Carregando…</p>';
  try {
    const { projects } = await api('/api/projects');
    if (!projects.length) {
      list.innerHTML = '<p class="muted">Nenhum projeto indexado ainda. Clique em “Adicionar pasta”.</p>';
      return;
    }
    list.innerHTML = projects
      .map(
        (p) => `
      <div class="project-row" data-id="${p.id}">
        <div class="meta">
          <div class="name">${esc(p.name)}</div>
          <div class="path">${esc(p.root_path)}</div>
          <div class="stats">${p.file_count} arquivos · ${p.symbol_count} símbolos · ${p.last_indexed ? 'indexado ' + esc(p.last_indexed) : 'não indexado'}</div>
        </div>
        <div class="row">
          <button class="ghost btn-status" data-id="${p.id}">status</button>
          <button class="primary btn-index" data-id="${p.id}">Indexar</button>
        </div>
      </div>`,
      )
      .join('');
    $$('.btn-index').forEach((b) => b.addEventListener('click', () => startIndex(b.dataset.id)));
    $$('.btn-status').forEach((b) => b.addEventListener('click', () => showStatus(b.dataset.id)));
  } catch (e) {
    list.innerHTML = `<p class="error">Erro: ${esc(String(e))}</p>`;
  }
}

$('#btn-add-project').addEventListener('click', () => {
  $('#add-project-form').classList.toggle('hidden');
  $('#new-project-path').focus();
});
$('#btn-cancel-add').addEventListener('click', () => $('#add-project-form').classList.add('hidden'));
$('#btn-confirm-add').addEventListener('click', async () => {
  const rootPath = $('#new-project-path').value.trim();
  const err = $('#add-project-error');
  err.classList.add('hidden');
  if (!rootPath) return;
  try {
    const res = await api('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootPath }),
    });
    if (res.error) throw new Error(res.error);
    $('#new-project-path').value = '';
    $('#add-project-form').classList.add('hidden');
    loadProjects();
  } catch (e) {
    err.textContent = String(e.message || e);
    err.classList.remove('hidden');
  }
});

async function showStatus(id) {
  try {
    const s = await api(`/api/projects/${id}/status`);
    const row = document.querySelector(`.project-row[data-id="${id}"] .stats`);
    if (s.error || !s.stats) {
      row.textContent = s.error || 'sem dados';
      return;
    }
    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
    row.innerHTML =
      `${s.stats.file_count} arquivos · ${s.stats.symbol_count} símbolos · ` +
      `vetores: arq ${pct(s.coverage.files.embedded, s.coverage.files.total)}% / ` +
      `simb ${pct(s.coverage.symbols.embedded, s.coverage.symbols.total)}%` +
      (s.cost.total_usd > 0 ? ` · $${s.cost.total_usd.toFixed(4)} gasto` : '');
  } catch (e) {
    console.error(e);
  }
}

async function startIndex(id) {
  const panel = $('#index-panel');
  const progress = $('#index-progress');
  const counter = $('#index-counter');
  const phase = $('#index-phase');
  const log = $('#index-log');
  panel.classList.remove('hidden');
  log.classList.add('hidden');
  progress.value = 0;
  counter.textContent = 'iniciando…';
  phase.textContent = 'structural';

  let runId;
  try {
    const res = await api(`/api/projects/${id}/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.error) throw new Error(res.error);
    runId = res.runId;
  } catch (e) {
    counter.textContent = `Erro: ${e.message || e}`;
    return;
  }

  const es = new EventSource(`/api/projects/${id}/index/stream?runId=${encodeURIComponent(runId)}`);
  es.onmessage = (msg) => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (ev.type === 'progress') {
      phase.textContent = ev.phase;
      if (ev.total && ev.current != null) {
        progress.max = ev.total;
        progress.value = ev.current;
        counter.textContent = `${ev.phase}: ${ev.current}/${ev.total}`;
      }
    } else if (ev.type === 'log') {
      log.classList.remove('hidden');
      log.textContent += ev.line + '\n';
      log.scrollTop = log.scrollHeight;
    } else if (ev.type === 'done') {
      es.close();
      counter.textContent = ev.ok ? `✔ ${ev.message}` : `✗ ${ev.message}`;
      phase.textContent = ev.ok ? 'done' : 'failed';
      if (ev.ok) loadProjects();
    }
  };
  es.onerror = () => {
    counter.textContent = 'conexão interrompida';
    es.close();
  };
}

// ─── config ───────────────────────────────────────────────────────────────────
let pendingModelId = '';
let pendingInference = false;
let selectedModel = null; // enrich model {id, needsInference, resolvedId}
let pendingExplorerModelId = '';
let explorerModels = [];
let copilotConnected = false;
let copilotPollTimer = null;

async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    $('#env-path').textContent = cfg.path || '~/.code-context/.env';
    const v = cfg.values || {};
    $('#aws-region').value = v.AWS_REGION || '';
    $('#aws-access-key-id').value = v.AWS_ACCESS_KEY_ID || '';
    if (v.AWS_SECRET_ACCESS_KEY === '<set>') {
      $('#aws-secret-access-key').value = '';
      $('#aws-secret-access-key').placeholder = '•••••••• (já salvo)';
    }
    if (v.AWS_SESSION_TOKEN === '<set>') $('#aws-session-token').placeholder = '(já salvo)';
    $('#budget').value = v.MCP_INDEX_BUDGET || '';

    $('#enrich-provider').value = (v.CODE_CONTEXT_ANALYSIS || '').toLowerCase();
    pendingModelId = v.CODE_CONTEXT_ANALYSIS_MODEL || '';
    pendingInference = v.CODE_CONTEXT_ANALYSIS_INFERENCE === '1';

    $('#explorer-provider').value = (v.CODE_CONTEXT_EXPLORER_PROVIDER || '').toLowerCase();
    pendingExplorerModelId = v.CODE_CONTEXT_EXPLORER_MODEL || '';

    $('#enable-exec').checked = v.MCP_EXEC === '1';

    await loadCopilotStatus();
    loadEnrichModels();
    loadExplorerModels();
  } catch (e) {
    $('#models-status').textContent = `Erro: ${e.message || e}`;
  }
}

/** Fetch the model list for a backend (same {models,...} shape for both). */
async function modelsFor(provider) {
  if (provider === 'copilot') return api('/api/copilot/models');
  if (provider === 'bedrock') return api('/api/models');
  return { models: [] };
}

function modelCardHtml(m) {
  return `
    <div class="model-card" data-id="${esc(m.id)}">
      <div class="mc-label">${esc(m.label)}</div>
      <div class="mc-provider">${esc(m.provider)}${m.supportsStream ? ' · stream' : ''}</div>
      <div class="mc-price">$${m.price.inPerMTok.toFixed(3)} / $${m.price.outPerMTok.toFixed(3)} por MTok (in/out)</div>
      ${m.needsInference ? '<div class="mc-inf">perfil regional: ' + esc(m.resolvedId) + '</div>' : ''}
      <div class="mc-price muted">id: ${esc(m.resolvedId)}</div>
    </div>`;
}

function renderModelGrid(models) {
  const grid = $('#models-grid');
  grid.innerHTML = models.map(modelCardHtml).join('');
  $$('.model-card').forEach((card) => {
    card.addEventListener('click', () => {
      $$('.model-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedModel = models.find((x) => x.id === card.dataset.id);
    });
    if (card.dataset.id === pendingModelId) {
      card.classList.add('selected');
      selectedModel = models.find((x) => x.id === pendingModelId);
    }
  });
  pendingModelId = '';
}

async function loadEnrichModels() {
  const status = $('#models-status');
  const grid = $('#models-grid');
  const provider = $('#enrich-provider').value;
  selectedModel = null;
  grid.innerHTML = '';
  if (!provider || provider === 'mock') {
    status.textContent = provider === 'mock' ? 'Mock: sem modelo, sem custo.' : 'Enriquecimento desligado.';
    return;
  }
  if (provider === 'copilot' && !copilotConnected) {
    status.innerHTML = '<span class="muted">Conecte o Copilot acima para listar os modelos.</span>';
    return;
  }
  status.textContent = 'Carregando modelos…';
  try {
    const { models, region, error, hint } = await modelsFor(provider);
    if (error) {
      status.innerHTML = `<span class="error">${esc(error)}</span>` + (hint ? `<br><span class="muted">${esc(hint)}</span>` : '');
      return;
    }
    if (!models || !models.length) {
      status.textContent = 'Nenhum modelo encontrado.';
      return;
    }
    status.innerHTML = `<span class="muted">${models.length} modelo(s)${region ? ` na região <code>${esc(region)}</code>` : ''}. Clique para selecionar.</span>`;
    renderModelGrid(models);
  } catch (e) {
    status.textContent = `Erro: ${e.message || e}`;
  }
}

async function loadExplorerModels() {
  const sel = $('#explorer-model');
  const ep = $('#explorer-provider').value || $('#enrich-provider').value;
  explorerModels = [];
  sel.innerHTML = '<option value="">—</option>';
  if (!ep || ep === 'mock') return;
  if (ep === 'copilot' && !copilotConnected) {
    sel.innerHTML = '<option value="">conecte o Copilot</option>';
    return;
  }
  try {
    const { models, error } = await modelsFor(ep);
    if (error || !models) return;
    explorerModels = models;
    sel.innerHTML = '<option value="">—</option>' + models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    if (pendingExplorerModelId) {
      sel.value = pendingExplorerModelId;
      pendingExplorerModelId = '';
    }
  } catch {
    /* ignore */
  }
}

$('#enrich-provider').addEventListener('change', () => { loadEnrichModels(); loadExplorerModels(); });
$('#explorer-provider').addEventListener('change', loadExplorerModels);
$('#btn-refresh-models').addEventListener('click', () => { loadEnrichModels(); loadExplorerModels(); });

// ─── Copilot OAuth ──────────────────────────────────────────────────────────
async function loadCopilotStatus() {
  try {
    const s = await api('/api/copilot/status');
    copilotConnected = !!s.connected;
    $('#copilot-state').innerHTML = s.connected
      ? `<span style="color:var(--ok)">✔ Conectado${s.login ? ` como <strong>${esc(s.login)}</strong>` : ''}</span>`
      : 'Não conectado';
    $('#btn-copilot-connect').classList.toggle('hidden', s.connected);
    $('#btn-copilot-disconnect').classList.toggle('hidden', !s.connected);
  } catch {
    $('#copilot-state').textContent = 'status indisponível';
  }
}

async function startCopilotLogin() {
  const dev = $('#copilot-device');
  dev.classList.remove('hidden');
  $('#copilot-poll').textContent = 'iniciando…';
  try {
    const r = await api('/api/copilot/login/start', { method: 'POST' });
    if (r.error) { $('#copilot-poll').innerHTML = `<span class="error">${esc(r.error)}</span>`; return; }
    $('#copilot-code').textContent = r.user_code;
    const a = $('#copilot-uri');
    a.href = r.verification_uri;
    a.textContent = r.verification_uri;
    $('#copilot-poll').textContent = 'aguardando autorização…';
    pollCopilotLogin(r.loginId, (r.interval || 5) * 1000);
  } catch (e) {
    $('#copilot-poll').innerHTML = `<span class="error">${esc(String(e))}</span>`;
  }
}

function pollCopilotLogin(loginId, intervalMs) {
  if (copilotPollTimer) clearTimeout(copilotPollTimer);
  copilotPollTimer = setTimeout(async () => {
    try {
      const s = await api(`/api/copilot/login/status?loginId=${encodeURIComponent(loginId)}`);
      if (s.status === 'connected') {
        $('#copilot-poll').innerHTML = `<span style="color:var(--ok)">✔ conectado${s.login ? ` como ${esc(s.login)}` : ''}</span>`;
        $('#copilot-device').classList.add('hidden');
        await loadCopilotStatus();
        loadEnrichModels();
        loadExplorerModels();
        return;
      }
      if (s.status === 'expired' || s.status === 'unknown') { $('#copilot-poll').innerHTML = '<span class="error">código expirou — tente novamente.</span>'; return; }
      if (s.status === 'error') { $('#copilot-poll').innerHTML = `<span class="error">${esc(s.error || 'erro')}</span>`; return; }
      pollCopilotLogin(loginId, s.interval ? s.interval * 1000 : intervalMs);
    } catch {
      pollCopilotLogin(loginId, intervalMs);
    }
  }, intervalMs);
}

$('#btn-copilot-connect').addEventListener('click', startCopilotLogin);
$('#btn-copilot-disconnect').addEventListener('click', async () => {
  await api('/api/copilot/logout', { method: 'POST' });
  await loadCopilotStatus();
  loadEnrichModels();
  loadExplorerModels();
});

$('#btn-toggle-secret').addEventListener('click', () => {
  const el = $('#aws-secret-access-key');
  const wasPwd = el.type === 'password';
  el.type = wasPwd ? 'text' : 'password';
  $('#btn-toggle-secret').textContent = wasPwd ? 'ocultar' : 'mostrar';
});

$('#btn-test-aws').addEventListener('click', async () => {
  const out = $('#aws-test-result');
  out.textContent = 'testando…';
  const body = {
    region: $('#aws-region').value.trim() || undefined,
    accessKeyId: $('#aws-access-key-id').value.trim() || undefined,
    secretAccessKey: $('#aws-secret-access-key').value || undefined,
    sessionToken: $('#aws-session-token').value || undefined,
    model: selectedModel ? selectedModel.resolvedId : undefined,
    inference: selectedModel ? selectedModel.needsInference : undefined,
  };
  try {
    const res = await api('/api/config/test-aws', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      out.innerHTML = `<span style="color:var(--ok)">✔ OK — ${res.stage}${res.modelsFound != null ? ' · ' + res.modelsFound + ' modelo(s)' : ''}${res.modelId ? ' · converse: ' + esc(res.modelId) : ''}</span>`;
    } else {
      out.innerHTML = `<span class="error">✗ ${esc(res.stage)}: ${esc(res.error)}</span>`;
    }
  } catch (e) {
    out.innerHTML = `<span class="error">✗ ${esc(String(e))}</span>`;
  }
});

$('#btn-save-config').addEventListener('click', async () => {
  const out = $('#config-save-result');
  out.textContent = 'salvando…';
  const enrichProvider = $('#enrich-provider').value;
  const explorerProvider = $('#explorer-provider').value;
  const explorerModelId = $('#explorer-model').value;
  const explorerModel = explorerModels.find((m) => m.id === explorerModelId);
  const updates = {
    AWS_REGION: $('#aws-region').value.trim() || '',
    AWS_ACCESS_KEY_ID: $('#aws-access-key-id').value.trim() || '',
    AWS_SECRET_ACCESS_KEY: $('#aws-secret-access-key').value || '',
    AWS_SESSION_TOKEN: $('#aws-session-token').value || '',
    MCP_INDEX_BUDGET: $('#budget').value || '',
    CODE_CONTEXT_ANALYSIS: enrichProvider || '',
    CODE_CONTEXT_ANALYSIS_MODEL: enrichProvider && enrichProvider !== 'mock' && selectedModel ? selectedModel.id : '',
    CODE_CONTEXT_ANALYSIS_INFERENCE: selectedModel && selectedModel.needsInference ? '1' : '',
    CODE_CONTEXT_EXPLORER_PROVIDER: explorerProvider || '',
    CODE_CONTEXT_EXPLORER_MODEL: explorerModelId || '',
    CODE_CONTEXT_EXPLORER_INFERENCE: explorerModel && explorerModel.needsInference ? '1' : '',
    MCP_EXEC: $('#enable-exec').checked ? '1' : '',
  };
  try {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    out.innerHTML = `<span style="color:var(--ok)">✔ salvo — reinicie o <code>code-context serve</code> no editor para aplicar.</span>`;
    loadConfig();
  } catch (e) {
    out.innerHTML = `<span class="error">✗ ${esc(String(e))}</span>`;
  }
});

// ─── search ───────────────────────────────────────────────────────────────────
async function populateProjectSelect() {
  try {
    const { projects } = await api('/api/projects');
    const sel = $('#search-project');
    sel.innerHTML = projects.length
      ? projects.map((p) => `<option value="${p.root_path}">${esc(p.name)}</option>`).join('')
      : '<option value="">nenhum projeto</option>';
  } catch (e) {
    console.error(e);
  }
}

$('#btn-search').addEventListener('click', async () => {
  const out = $('#search-results');
  const query = $('#search-query').value.trim();
  const rootPath = $('#search-project').value;
  if (!query || !rootPath) {
    out.innerHTML = '<p class="muted">Selecione um projeto e digite a consulta.</p>';
    return;
  }
  out.innerHTML = '<p class="muted">buscando…</p>';
  try {
    const res = await api('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rootPath,
        query,
        mode: $('#search-mode').value,
        type: $('#search-type').value,
        limit: 20,
      }),
    });
    if (res.error || !res.results || !res.results.length) {
      out.innerHTML = `<p class="muted">${esc(res.error || 'nenhum resultado.')}</p>`;
      return;
    }
    out.innerHTML = res.results
      .map((r) => {
        const d = r.data || {};
        const loc = r.type === 'file' ? d.path : `${d.file_path}:${d.line ?? '?'}`;
        const tag = r.score > 0 ? `<span class="score">[${r.score.toFixed(2)}]</span>` : '';
        const kind = r.type === 'file' ? `[file] ${d.language || ''}` : `[${d.kind}] ${d.name || ''}`;
        return `<div class="result-row">${tag} <span class="kind">${esc(kind)}</span><div class="path">${esc(String(loc))}</div></div>`;
      })
      .join('');
  } catch (e) {
    out.innerHTML = `<p class="error">Erro: ${esc(String(e))}</p>`;
  }
});

// ─── utils ────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// boot
activateTab(currentTab());
