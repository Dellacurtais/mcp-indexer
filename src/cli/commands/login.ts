/**
 * `login copilot` — connect a GitHub Copilot account via the OAuth device flow
 * so enrich / the explorer can use the user's Copilot subscription as the LLM.
 * Stores the GitHub PAT + short-lived Copilot token in oauth_tokens (the
 * `copilot` provider row is created first to satisfy the FK).
 */
import { ProviderStore } from '@ctx/store/provider-store.js';
import { loadConfig } from '@ctx/shared/utils/config.js';
import { startDeviceFlow, pollDeviceFlow, exchangeForCopilotToken } from '@ctx/llm/copilot/oauth.js';
import { log } from './shared.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const out = (s: string): void => {
  process.stdout.write(s.endsWith('\n') ? s : s + '\n');
};

export async function runLogin(provider: string): Promise<void> {
  const p = provider.toLowerCase();
  if (p !== 'copilot') {
    log(`unknown provider "${provider}" — only "copilot" is supported.`);
    process.exitCode = 1;
    return;
  }
  await runLoginCopilot();
}

export async function runLoginCopilot(): Promise<void> {
  const store = new ProviderStore(loadConfig().dbPath);
  try {
    // FK: oauth_tokens.provider_id -> provider_configs(id). Create the row first.
    store.upsertProvider({
      id: 'copilot',
      name: 'GitHub Copilot',
      kind: 'copilot',
      auth_mode: 'oauth',
      enabled: true,
      use_for_general: true,
    });

    const start = await startDeviceFlow();
    out('');
    out(`  1. Open:  ${start.verification_uri}`);
    out(`  2. Enter code:  ${start.user_code}`);
    out('  (waiting for authorization…)');

    let interval = Math.max(1, start.interval ?? 5) * 1000;
    const deadline = Date.now() + Math.max(60, start.expires_in ?? 900) * 1000;
    let pat: string | null = null;
    let scope = 'read:user';

    while (Date.now() < deadline) {
      await sleep(interval);
      const res = await pollDeviceFlow(start.device_code);
      if (res.status === 'authorized') {
        pat = res.access_token;
        scope = res.scope || scope;
        break;
      }
      if (res.status === 'slow_down') {
        interval = Math.max(interval, res.interval * 1000);
        continue;
      }
      if (res.status === 'expired') {
        log('device code expired — run `code-context login copilot` again.');
        process.exitCode = 1;
        return;
      }
      // pending → keep polling
    }

    if (!pat) {
      log('timed out waiting for authorization — run the command again.');
      process.exitCode = 1;
      return;
    }

    const fresh = await exchangeForCopilotToken(pat);
    store.setOAuth({
      provider_id: 'copilot',
      access_token: fresh.token, // short-lived Copilot token
      refresh_token: pat, // long-lived GitHub PAT (used to re-exchange)
      expires_at: fresh.expires_at,
      scope,
      extra: fresh.extra,
    });
    log('✓ Copilot connected. Try:  code-context enrich <root> --kind copilot   (or set it in the dashboard)');
  } catch (e) {
    log(`login failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
