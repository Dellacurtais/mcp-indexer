import type { Database as DB } from 'better-sqlite3';
import type { OAuthTokenRow } from './types.js';
import { hydrateOAuth, type OAuthTokenRaw } from './hydrators.js';

export interface SetOAuthInput {
  provider_id: string;
  access_token: string;
  refresh_token?: string | null;
  expires_at?: number | null;
  scope?: string | null;
  extra?: Record<string, unknown>;
}

export function get(db: DB, providerId: string): OAuthTokenRow | null {
  const row = db
    .prepare('SELECT * FROM oauth_tokens WHERE provider_id = ?')
    .get(providerId) as OAuthTokenRaw | undefined;
  return row ? hydrateOAuth(row) : null;
}

export function set(db: DB, input: SetOAuthInput): void {
  db
    .prepare(
      `INSERT INTO oauth_tokens (provider_id, access_token, refresh_token, expires_at, scope, extra, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(provider_id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at,
         scope = excluded.scope,
         extra = excluded.extra,
         updated_at = excluded.updated_at`
    )
    .run(
      input.provider_id,
      input.access_token,
      input.refresh_token ?? null,
      input.expires_at ?? null,
      input.scope ?? null,
      JSON.stringify(input.extra ?? {})
    );
}

export function del(db: DB, providerId: string): void {
  db.prepare('DELETE FROM oauth_tokens WHERE provider_id = ?').run(providerId);
}
