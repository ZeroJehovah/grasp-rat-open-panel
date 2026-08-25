import type { MetaResponse, ResourceResponse } from './types';

type RealtimeResource = 'chat' | 'map' | 'players' | 'kills';
type HistoryResource = 'chat' | 'players' | 'kills';

interface ConditionalEntry {
  etag: string;
  value: unknown;
}

// realtime 只保留每个资源的最新一份（键固定为 `${resource}:latest`），history 按区间键缓存。
const realtimeCache = new Map<string, ResourceResponse>();
const historyCache = new Map<string, ResourceResponse>();
// 条件请求缓存：etag 必须和产生它的 body 存在一起，否则 304 会回放到错配的数据。
const conditionalCache = new Map<string, ConditionalEntry>();
const CONDITIONAL_CACHE_LIMIT = 16;
const HISTORY_CACHE_LIMIT = 32;

function trimCache(cache: Map<string, unknown>, limit: number): void {
  for (const key of cache.keys()) {
    if (cache.size <= limit) return;
    cache.delete(key);
  }
}

function rememberConditional(cacheKey: string, etag: string | null, value: unknown): void {
  // 没有 etag 就连旧的一起丢掉，避免下次带着过期 etag 换回过期 body。
  conditionalCache.delete(cacheKey);
  if (!etag) return;
  conditionalCache.set(cacheKey, { etag, value });
  trimCache(conditionalCache, CONDITIONAL_CACHE_LIMIT);
}

async function getJson<T>(url: string, signal?: AbortSignal, cacheKey?: string): Promise<T> {
  const headers: HeadersInit = {};
  const cached = cacheKey ? conditionalCache.get(cacheKey) : undefined;
  if (cached) headers['If-None-Match'] = cached.etag;
  const response = await fetch(url, { signal, headers });
  if (response.status === 304) {
    // 只有我们自己发过 If-None-Match 才可能收到 304；没有配对 body 时响应体是空的，不能交给 json() 解析。
    if (cached) return cached.value as T;
    throw new Error('304 Not Modified without a cached response');
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const value = await response.json() as T;
  if (cacheKey) rememberConditional(cacheKey, response.headers.get('etag'), value);
  return value;
}

export async function getMeta(signal?: AbortSignal): Promise<MetaResponse> {
  return getJson<MetaResponse>('/api/v1/meta', signal);
}

export async function getVersion(signal?: AbortSignal): Promise<{ versionToken: string | null; snapshotId: string | null; observedAt: string | null; serverDay?: string | null }> {
  return getJson('/api/v1/realtime/version', signal);
}

function realtimeKey(resource: RealtimeResource, version: string | null): string {
  return `${resource}:${version || 'latest'}`;
}

function historyKey(resource: HistoryResource, from: string, to: string): string {
  return `${resource}:${from}:${to}`;
}

async function getRealtimeResource(resource: RealtimeResource, version: string | null, signal?: AbortSignal): Promise<ResourceResponse> {
  const value = await getJson<ResourceResponse>(`/api/v1/realtime/${resource}${version ? `?version=${encodeURIComponent(version)}` : ''}`, signal, realtimeKey(resource, version));
  // latest 槽每次都要刷新：轮询时 version 非空，只写 version 键会让 latest 永远停在首次快照，
  // 于是每次切回标签页都先渲染那份旧快照再跳到当前状态。
  if (!value.unchanged) realtimeCache.set(realtimeKey(resource, null), value);
  return value;
}

async function getHistoryResource(resource: HistoryResource, from: string, to: string, signal?: AbortSignal): Promise<ResourceResponse> {
  const key = historyKey(resource, from, to);
  const cached = historyCache.get(key);
  if (cached) return cached;
  const value = await getJson<ResourceResponse>(`/api/v1/history/${resource}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, signal, key);
  historyCache.set(key, value);
  trimCache(historyCache, HISTORY_CACHE_LIMIT);
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
  conditionalCache.clear();
}
