/**
 * /api/copilot/* — connect a GitHub Copilot account from the dashboard via the
 * OAuth device flow, report status, disconnect, and list its chat models.
 *
 * Secrets (GitHub PAT + Copilot token) are persisted in ProviderStore
 * (oauth_tokens), never in the .env file. In-flight device-flow state lives in a
 * module-level map keyed by a server-generated loginId (nothing persisted until
 * the final tokens land).
 */
import { Hono } from 'hono';
import { createAndSeedProviderStore } from '@ctx/indexer/bootstrap/index.js';
import { loadConfig } from '@ctx/shared/utils/config.js';
import { startDeviceFlow, pollDeviceFlow, exchangeForCopilotToken } from '@ctx/llm/copilot/oauth.js';
import { listCopilotModels } from '@ctx/llm/copilot/models.js';
import type { ProviderStore } from '@ctx/store/provider-store.js';

export const copilotApp = new Hono();

function store(): ProviderStore {
  return createAndSeedProviderStore(loadConfig().dbPath);
}

interface Pending {
  device_code: string;
  interval: number;
  expiresAt: number;
}
const pending = new Map<string, Pending>();
let counter = 0;

/** Best-effort GitHub username for the "Connected as <login>" display. */
async function githubLogin(pat: string): Promise<string | null> {
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${pat}`, Accept: 'application/json', 'User-Agent': 'code-context' },
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { login?: string };
    return d.login ?? null;
  } catch {
    return null;
  }
}

const loginOf = (extra: Record<string, unknown> | undefined): string | null =>
  extra && typeof extra.login === 'string' ? extra.login : null;

/** POST /api/copilot/login/start — kick off the device flow. */
copilotApp.post('/copilot/login/start', async (c) => {
  try {
    const s = await startDeviceFlow();
    const loginId = `lg_${++counter}`;
    pending.set(loginId, {
      device_code: s.device_code,
      interval: Math.max(1, s.interval ?? 5),
      expiresAt: Date.now() + Math.max(60, s.expires_in ?? 900) * 1000,
    });
    return c.json({ loginId, user_code: s.user_code, verification_uri: s.verification_uri, interval: s.interval, expires_in: s.expires_in });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 200);
  }
});

/** GET /api/copilot/login/status?loginId= — poll once; commit tokens on success. */
copilotApp.get('/copilot/login/status', async (c) => {
  const loginId = c.req.query('loginId') ?? '';
  const p = pending.get(loginId);
  if (!p) return c.json({ status: 'unknown' }, 404);
  if (Date.now() > p.expiresAt) {
    pending.delete(loginId);
    return c.json({ status: 'expired' });
  }
  let res;
  try {
    res = await pollDeviceFlow(p.device_code);
  } catch (e) {
    return c.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, 200);
  }
  if (res.status === 'pending') return c.json({ status: 'pending' });
  if (res.status === 'slow_down') {
    p.interval = res.interval;
    return c.json({ status: 'pending', interval: res.interval });
  }
  if (res.status === 'expired') {
    pending.delete(loginId);
    return c.json({ status: 'expired' });
  }

  // authorized → exchange the PAT and persist (PAT in refresh_token, token in access_token)
  const pat = res.access_token;
  try {
    const fresh = await exchangeForCopilotToken(pat);
    const login = await githubLogin(pat);
    const st = store();
    try {
      st.upsertProvider({
        id: 'copilot',
        name: 'GitHub Copilot',
        kind: 'copilot',
        auth_mode: 'oauth',
        enabled: true,
        use_for_general: true,
        extra: login ? { login } : {},
      });
      st.setOAuth({
        provider_id: 'copilot',
        access_token: fresh.token,
        refresh_token: pat,
        expires_at: fresh.expires_at,
        scope: res.scope || 'read:user',
        extra: { ...fresh.extra, login },
      });
    } finally {
      st.close();
    }
    pending.delete(loginId);
    return c.json({ status: 'connected', login });
  } catch (e) {
    return c.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, 200);
  }
});

/** GET /api/copilot/status — connected? (never returns token material) */
copilotApp.get('/copilot/status', (c) => {
  const st = store();
  try {
    const tok = st.getOAuth('copilot');
    const prov = st.getProvider('copilot');
    const login = loginOf(prov?.extra) ?? loginOf(tok?.extra);
    return c.json({ connected: !!tok, login });
  } finally {
    st.close();
  }
});

/** POST /api/copilot/logout — drop the stored tokens. */
copilotApp.post('/copilot/logout', (c) => {
  const st = store();
  try {
    st.deleteOAuth('copilot');
    const prov = st.getProvider('copilot');
    if (prov) {
      st.upsertProvider({ id: 'copilot', name: prov.name, kind: 'copilot', auth_mode: 'oauth', enabled: false });
    }
    return c.json({ connected: false });
  } finally {
    st.close();
  }
});

/** GET /api/copilot/models — chat models in the same shape as /api/models. */
copilotApp.get('/copilot/models', async (c) => {
  const st = store();
  try {
    if (!st.getOAuth('copilot')) return c.json({ models: [], error: 'not connected' });
    const raw = await listCopilotModels(st);
    const models = raw.map((m) => ({
      id: m.id,
      label: m.name,
      provider: 'GitHub Copilot',
      needsInference: false,
      resolvedId: m.id,
      supportsStream: true,
      price: { inPerMTok: 0, outPerMTok: 0 },
    }));
    return c.json({ models });
  } catch (e) {
    return c.json({ models: [], error: e instanceof Error ? e.message : String(e) }, 200);
  } finally {
    st.close();
  }
});
