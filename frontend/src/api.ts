import type { HistoryResponse, MetaResponse, RealtimeResponse } from './types';

const realtimeCache = new Map<string, RealtimeResponse>();
const historyCache = new Map<string, HistoryResponse>();

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

export async function getMeta(signal?: AbortSignal): Promise<MetaResponse> {
  return getJson<MetaResponse>('/api/v1/meta', signal);
}

export async function getVersion(signal?: AbortSignal): Promise<{ versionToken: string | null; snapshotId: string | null; observedAt: string | null }> {
  return getJson('/api/v1/realtime/version', signal);
}

export async function getRealtime(version: string | null, signal?: AbortSignal): Promise<RealtimeResponse> {
  const suffix = version ? `?version=${encodeURIComponent(version)}` : '';
  const value = await getJson<RealtimeResponse>(`/api/v1/realtime${suffix}`, signal);
  if (!value.unchanged) realtimeCache.set(value.versionToken || version || 'latest', value);
  return value;
}

export async function getHistory(from: string, to: string, signal?: AbortSignal): Promise<HistoryResponse> {
  const key = `${from}:${to}`;
  const cached = historyCache.get(key);
  if (cached) return cached;
  const value = await getJson<HistoryResponse>(`/api/v1/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, signal);
  historyCache.set(key, value);
  return value;
}

export function mergeById<T>(oldItems: T[], newItems: T[], key: keyof T): T[] {
  const merged = new Map<string, T>();
  [...oldItems, ...newItems].forEach(item => merged.set(String(item[key] ?? ''), item));
  return [...merged.values()];
}

export function clearCaches(): void {
  realtimeCache.clear();
  historyCache.clear();
}
