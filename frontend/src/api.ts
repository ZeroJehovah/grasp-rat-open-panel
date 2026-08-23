import type { MetaResponse, ResourceResponse } from './types';

const realtimeCache = new Map<string, ResourceResponse>();
const historyCache = new Map<string, ResourceResponse>();
const etags = new Map<string, string>();

async function getJson<T>(url: string, signal?: AbortSignal, cacheKey?: string): Promise<T> {
  const headers: HeadersInit = {};
  const etag = cacheKey ? etags.get(cacheKey) : undefined;
  if (etag) headers['If-None-Match'] = etag;
  const response = await fetch(url, { signal, headers });
  if (response.status === 304 && cacheKey) {
    const cached = realtimeCache.get(cacheKey) || historyCache.get(cacheKey);
    if (cached) return cached as T;
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  if (cacheKey && response.headers.get('etag')) etags.set(cacheKey, response.headers.get('etag')!);
  return response.json() as Promise<T>;
}

export async function getMeta(signal?: AbortSignal): Promise<MetaResponse> {
  return getJson<MetaResponse>('/api/v1/meta', signal);
}

export async function getVersion(signal?: AbortSignal): Promise<{ versionToken: string | null; snapshotId: string | null; observedAt: string | null; serverDay?: string | null }> {
  return getJson('/api/v1/realtime/version', signal);
}

type RealtimeResource = 'chat' | 'map' | 'players' | 'kills';
type HistoryResource = 'chat' | 'players' | 'kills';

function realtimeKey(resource: RealtimeResource, version: string | null): string {
  return `${resource}:${version || 'latest'}`;
}

function historyKey(resource: HistoryResource, from: string, to: string): string {
  return `${resource}:${from}:${to}`;
}

async function getRealtimeResource(resource: RealtimeResource, version: string | null, signal?: AbortSignal): Promise<ResourceResponse> {
  const key = realtimeKey(resource, version);
  const value = await getJson<ResourceResponse>(`/api/v1/realtime/${resource}${version ? `?version=${encodeURIComponent(version)}` : ''}`, signal, key);
  if (!value.unchanged) realtimeCache.set(key, value);
  if (value.versionToken && !value.unchanged) realtimeCache.set(realtimeKey(resource, value.versionToken), value);
  return value;
}

async function getHistoryResource(resource: HistoryResource, from: string, to: string, signal?: AbortSignal): Promise<ResourceResponse> {
  const key = historyKey(resource, from, to);
  const cached = historyCache.get(key);
  if (cached) return cached;
  const value = await getJson<ResourceResponse>(`/api/v1/history/${resource}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, signal, key);
  historyCache.set(key, value);
  return value;
}

export function getRealtimeChat(version: string | null, signal?: AbortSignal) { return getRealtimeResource('chat', version, signal); }
export function getRealtimeMap(version: string | null, signal?: AbortSignal) { return getRealtimeResource('map', version, signal); }
export function getRealtimePlayers(version: string | null, signal?: AbortSignal) { return getRealtimeResource('players', version, signal); }
export function getRealtimeKills(version: string | null, signal?: AbortSignal) { return getRealtimeResource('kills', version, signal); }

export function getHistoryChat(from: string, to: string, signal?: AbortSignal) { return getHistoryResource('chat', from, to, signal); }
export function getHistoryPlayers(from: string, to: string, signal?: AbortSignal) { return getHistoryResource('players', from, to, signal); }
export function getHistoryKills(from: string, to: string, signal?: AbortSignal) { return getHistoryResource('kills', from, to, signal); }

export function getResource(scope: 'realtime' | 'history', resource: RealtimeResource, argument: string | null | { from: string; to: string }, signal?: AbortSignal): Promise<ResourceResponse> {
  if (scope === 'realtime') return getRealtimeResource(resource, argument as string | null, signal);
  return getHistoryResource(resource as HistoryResource, (argument as { from: string; to: string }).from, (argument as { from: string; to: string }).to, signal);
}

export function getCachedResource(scope: 'realtime' | 'history', resource: string, key: string): ResourceResponse | null {
  if (scope === 'realtime') return realtimeCache.get(`${resource}:${key || 'latest'}`) || null;
  return historyCache.get(`${resource}:${key}`) || null;
}

export function clearCaches(): void {
  realtimeCache.clear();
  historyCache.clear();
  etags.clear();
}
