import type { MetaResponse, ResourceResponse } from './types';

type RealtimeResource = 'chat' | 'map' | 'players' | 'kills';
type HistoryResource = 'chat' | 'players' | 'kills';

// 后端分页/过滤参数。后端按 (区间, 页, 过滤条件) 缓存整页响应，所以这里必须把它们
// 一并算进本地缓存键和 If-None-Match 键，否则换一页会拿回上一页的 body。
export interface HistoryPageQuery {
  pageSize?: number | null;
  page?: number | 'last' | null;
  minDrop?: number | null;
  users?: number[] | null;
  onlyChat?: boolean | null;
}

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

export async function getVersion(signal?: AbortSignal): Promise<{ versionToken: string | null; snapshotId: string | null; observedAt: string | null; serverDay?: string | null; completeness?: string | null; warmingUp?: boolean; entityCount?: number | null }> {
  return getJson('/api/v1/realtime/version', signal);
}

function realtimeKey(resource: RealtimeResource, version: string | null): string {
  return `${resource}:${version || 'latest'}`;
}

// 参数顺序固定、用户 id 排序：同一组条件只能对应一个键，否则本地缓存和边缘缓存都会分裂。
export function historyQuerySuffix(page?: HistoryPageQuery | null): string {
  if (!page) return '';
  const params: string[] = [];
  if (page.pageSize) params.push(`pageSize=${page.pageSize}`);
  if (page.page) params.push(`page=${page.page}`);
  if (page.minDrop !== null && page.minDrop !== undefined) params.push(`minDrop=${page.minDrop}`);
  if (page.users && page.users.length > 0) params.push(`users=${page.users.slice().sort((left, right) => left - right).join(',')}`);
  // 关闭状态不带参数：默认值不该在缓存里多占一条与不带参数完全同内容的条目。
  if (page.onlyChat) params.push('onlyChat=1');
  return params.length === 0 ? '' : `&${params.join('&')}`;
}

function historyKey(resource: HistoryResource, from: string, to: string, page?: HistoryPageQuery | null): string {
  return `${resource}:${from}:${to}${historyQuerySuffix(page)}`;
}

async function getRealtimeResource(resource: RealtimeResource, version: string | null, signal?: AbortSignal): Promise<ResourceResponse> {
  const value = await getJson<ResourceResponse>(`/api/v1/realtime/${resource}${version ? `?version=${encodeURIComponent(version)}` : ''}`, signal, realtimeKey(resource, version));
  // latest 槽每次都要刷新：轮询时 version 非空，只写 version 键会让 latest 永远停在首次快照，
  // 于是每次切回标签页都先渲染那份旧快照再跳到当前状态。
  if (!value.unchanged) realtimeCache.set(realtimeKey(resource, null), value);
  return value;
}

async function getHistoryResource(resource: HistoryResource, from: string, to: string, page?: HistoryPageQuery | null, signal?: AbortSignal): Promise<ResourceResponse> {
  const key = historyKey(resource, from, to, page);
  const cached = historyCache.get(key);
  if (cached) return cached;
  const value = await getJson<ResourceResponse>(`/api/v1/history/${resource}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${historyQuerySuffix(page)}`, signal, key);
  historyCache.set(key, value);
  trimCache(historyCache, HISTORY_CACHE_LIMIT);
  return value;
}

export function getRealtimeChat(version: string | null, signal?: AbortSignal) { return getRealtimeResource('chat', version, signal); }
export function getRealtimeMap(version: string | null, signal?: AbortSignal) { return getRealtimeResource('map', version, signal); }
export function getRealtimePlayers(version: string | null, signal?: AbortSignal) { return getRealtimeResource('players', version, signal); }
export function getRealtimeKills(version: string | null, signal?: AbortSignal) { return getRealtimeResource('kills', version, signal); }

export function getHistoryChat(from: string, to: string, page?: HistoryPageQuery | null, signal?: AbortSignal) { return getHistoryResource('chat', from, to, page, signal); }
export function getHistoryPlayers(from: string, to: string, signal?: AbortSignal) { return getHistoryResource('players', from, to, null, signal); }
export function getHistoryKills(from: string, to: string, page?: HistoryPageQuery | null, signal?: AbortSignal) { return getHistoryResource('kills', from, to, page, signal); }

type HistoryArgument = { from: string; to: string; page?: HistoryPageQuery | null };

export function getResource(scope: 'realtime' | 'history', resource: RealtimeResource, argument: string | null | HistoryArgument, signal?: AbortSignal): Promise<ResourceResponse> {
  if (scope === 'realtime') return getRealtimeResource(resource, argument as string | null, signal);
  const history = argument as HistoryArgument;
  return getHistoryResource(resource as HistoryResource, history.from, history.to, history.page || null, signal);
}

export function getCachedResource(scope: 'realtime' | 'history', resource: string, key: string, page?: HistoryPageQuery | null): ResourceResponse | null {
  if (scope === 'realtime') return realtimeCache.get(`${resource}:${key || 'latest'}`) || null;
  return historyCache.get(`${resource}:${key}${historyQuerySuffix(page)}`) || null;
}

export function clearCaches(): void {
  realtimeCache.clear();
  historyCache.clear();
  conditionalCache.clear();
}
