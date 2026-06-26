/**
 * List the chat models the connected Copilot account can use. Hits the Copilot
 * OpenAI-compatible /models endpoint with a fresh token. Returns a de-duped list
 * of chat-capable models; embeddings and non-chat entries are dropped.
 */
import type { ProviderStore } from '@ctx/store/provider-store.js';
import { refreshIfExpired, copilotHeaders, getStoredCopilotEndpoints } from './oauth.js';

export interface CopilotModel {
  id: string;
  name: string;
}

interface RawModel {
  id?: string;
  name?: string;
  capabilities?: { type?: string };
  model_picker_enabled?: boolean;
}

export async function listCopilotModels(store: ProviderStore, providerId = 'copilot'): Promise<CopilotModel[]> {
  const token = await refreshIfExpired(store, providerId);
  if (!token) return [];
  const base = getStoredCopilotEndpoints(store, providerId) ?? 'https://api.githubcopilot.com';
  const r = await fetch(`${base}/models`, { headers: copilotHeaders(token) });
  if (!r.ok) throw new Error(`Copilot models request failed: HTTP ${r.status} ${await r.text()}`);
  const data = (await r.json()) as { data?: RawModel[] };
  const list = Array.isArray(data.data) ? data.data : [];
  const seen = new Set<string>();
  const out: CopilotModel[] = [];
  for (const m of list) {
    const id = m.id;
    if (!id || seen.has(id)) continue;
    const type = m.capabilities?.type;
    if (type && type !== 'chat') continue; // drop embeddings / non-chat
    seen.add(id);
    out.push({ id, name: m.name ?? id });
  }
  return out;
}
