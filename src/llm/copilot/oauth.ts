/**
 * GitHub Copilot OAuth device flow (individual / business edition).
 *
 * Flow:
 *   1. startDeviceFlow()            -> POST github.com/login/device/code
 *   2. pollDeviceFlow(device_code)  -> POST github.com/login/oauth/access_token
 *      until authorized; returns the GitHub PAT.
 *   3. exchangeForCopilotToken(pat) -> GET api.github.com/copilot_internal/v2/token
 *      -> short-lived Copilot API token (~25min) + `endpoints` map.
 *   4. refreshIfExpired(store, id)  -> re-exchanges the stored PAT on demand.
 *
 * Storage convention (oauth_tokens): the long-lived GitHub PAT lives in
 * `refresh_token`; the short-lived Copilot token in `access_token` + `expires_at`.
 *
 * NOTE on the identity headers below: GitHub's Copilot token-exchange and
 * /chat/completions endpoints REQUIRE a recognized Copilot editor client id +
 * `Copilot-Integration-Id` and reject invented values. These are PUBLIC client
 * identifiers (not secrets) — this tool authenticates as a Copilot editor
 * integration. They are overridable via env for forward-compatibility. They are
 * sent verbatim to GitHub and must never be echoed back in a user-facing error.
 */
import type { ProviderStore } from '@ctx/store/provider-store.js';

const COPILOT_EDITOR_HEADERS = {
  clientId: process.env.CODE_CONTEXT_COPILOT_CLIENT_ID ?? '01ab8ac9400c4e429b23',
  integrationId: process.env.CODE_CONTEXT_COPILOT_INTEGRATION_ID ?? 'vscode-chat',
  userAgent: 'GitHubCopilotChat/0.26.7',
  editorVersion: process.env.CODE_CONTEXT_COPILOT_EDITOR_VERSION ?? 'vscode/1.95.0',
  editorPluginVersion: 'copilot-chat/0.26.7',
};

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

export interface DeviceFlowStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'authorized'; access_token: string; scope: string };

export interface CopilotTokenExchange {
  token: string;
  expires_at: number;
  endpoints?: Record<string, string>;
  extra: Record<string, unknown>;
}

/** Headers the Copilot API requires on every request (exchange, /models, /chat/completions). */
export function copilotHeaders(token: string, scheme: 'bearer' | 'token' = 'bearer'): Record<string, string> {
  return {
    Authorization: scheme === 'token' ? `token ${token}` : `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': COPILOT_EDITOR_HEADERS.userAgent,
    'Editor-Version': COPILOT_EDITOR_HEADERS.editorVersion,
    'Editor-Plugin-Version': COPILOT_EDITOR_HEADERS.editorPluginVersion,
    'Copilot-Integration-Id': COPILOT_EDITOR_HEADERS.integrationId,
  };
}

/** Kick off the device flow. Returns the code the user types at verification_uri. */
export async function startDeviceFlow(): Promise<DeviceFlowStart> {
  const r = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': COPILOT_EDITOR_HEADERS.userAgent },
    body: JSON.stringify({ client_id: COPILOT_EDITOR_HEADERS.clientId, scope: 'read:user' }),
  });
  if (!r.ok) throw new Error(`GitHub device code request failed: HTTP ${r.status} ${await r.text()}`);
  return (await r.json()) as DeviceFlowStart;
}

/** One-shot poll of the device flow. */
export async function pollDeviceFlow(deviceCode: string): Promise<PollResult> {
  const r = await fetch(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': COPILOT_EDITOR_HEADERS.userAgent },
    body: JSON.stringify({
      client_id: COPILOT_EDITOR_HEADERS.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  if (!r.ok) throw new Error(`GitHub poll failed: HTTP ${r.status} ${await r.text()}`);
  const data = (await r.json()) as { error?: string; interval?: number; access_token?: string; scope?: string };
  if (data.error === 'authorization_pending') return { status: 'pending' };
  if (data.error === 'slow_down') return { status: 'slow_down', interval: data.interval ?? 10 };
  if (data.error === 'expired_token' || data.error === 'access_denied') return { status: 'expired' };
  if (data.access_token) return { status: 'authorized', access_token: data.access_token, scope: data.scope ?? '' };
  throw new Error(`Unexpected GitHub poll response: ${JSON.stringify(data)}`);
}

/** Exchange a long-lived GitHub PAT for a short-lived Copilot API token. */
export async function exchangeForCopilotToken(githubToken: string): Promise<CopilotTokenExchange> {
  const r = await fetch(COPILOT_TOKEN_URL, { headers: copilotHeaders(githubToken, 'token') });
  if (!r.ok) {
    throw new Error(
      `Copilot token exchange failed: HTTP ${r.status} ${await r.text()}. ` +
        `Common causes: the GitHub account has no Copilot subscription, or the token is invalid.`,
    );
  }
  const data = (await r.json()) as { token: string; expires_at: number; refresh_in?: number; endpoints?: Record<string, string> };
  return {
    token: data.token,
    expires_at: data.expires_at * 1000, // GitHub gives seconds; normalize to ms
    endpoints: data.endpoints,
    extra: { refresh_in: data.refresh_in, endpoints: data.endpoints },
  };
}

/** Preferred Copilot API base URL the server published at exchange time. */
export function getStoredCopilotEndpoints(store: ProviderStore, providerId: string): string | undefined {
  const tok = store.getOAuth(providerId);
  const extra = (tok?.extra ?? {}) as { endpoints?: { api?: string } };
  return extra.endpoints?.api;
}

/**
 * Ensure the stored Copilot token is fresh (re-exchange the PAT when within 60s
 * of expiry or absent). Returns a valid token, or null when the provider has no
 * stored credentials (caller should start the device flow).
 */
export async function refreshIfExpired(store: ProviderStore, providerId: string): Promise<string | null> {
  const tok = store.getOAuth(providerId);
  if (!tok || !tok.refresh_token) return null;
  const now = Date.now();
  if (tok.expires_at && tok.expires_at - now > 60_000) return tok.access_token;
  const fresh = await exchangeForCopilotToken(tok.refresh_token);
  store.setOAuth({
    provider_id: providerId,
    access_token: fresh.token,
    refresh_token: tok.refresh_token, // preserve the GitHub PAT
    expires_at: fresh.expires_at,
    scope: tok.scope,
    extra: { ...tok.extra, ...fresh.extra },
  });
  return fresh.token;
}
