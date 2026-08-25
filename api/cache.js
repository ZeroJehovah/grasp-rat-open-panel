'use strict';

// 进程内响应缓存。缓存的是"序列化后的响应体 + ETag"，命中时既不查库、也不重新
// 映射行、序列化和哈希；只剩压缩仍由 @fastify/compress 每次处理。
//
// 失效靠缓存键，不靠时间：实时资源按版本令牌分区，历史资源按日期范围加"该区间是否
// 已结束"分区。TTL 只是兜底——它回收内存，并给键表达不了的迟到写入（finalize-day
// 补写已结束日期、refresh-map 更新地图）设一个上界。
//
// 只有 API 进程使用它。写入走独立的 projector 进程，所以这里不需要写失效。

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 256;

const ETAG_TOKEN = /(?:W\/)?"[^"]*"/g;

// RFC 9110 规定 If-None-Match 用弱比较，`W/"x"` 必须匹配 `"x"`。Cloudflare 会把强
// ETag 改写成弱形式再交给浏览器，浏览器原样回传，所以精确字符串比较在公网上永远
// 不成立——修复前每次条件请求都在全量下载。
function ifNoneMatchSatisfied(header, etag) {
  if (!header || !etag) return false;
  const raw = String(header).trim();
  if (raw === '*') return true;
  const target = String(etag).replace(/^W\//, '');
  const candidates = raw.match(ETAG_TOKEN);
  if (!candidates) return false;
  return candidates.some(candidate => candidate.replace(/^W\//, '') === target);
}

class ResponseCache {
  constructor(options = {}) {
    this.maxBytes = Number.isFinite(Number(options.maxBytes)) ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
    this.maxEntries = Number.isFinite(Number(options.maxEntries)) ? Number(options.maxEntries) : DEFAULT_MAX_ENTRIES;
    this.now = options.now || (() => Date.now());
    this.entries = new Map();
    this.inFlight = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.coalesced = 0;
    this.evictions = 0;
    this.expired = 0;
  }

  get(key) {
    if (!key) return null;
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.remove(key, entry);
      this.expired += 1;
      this.misses += 1;
      return null;
    }
    // Map 保持插入顺序，删掉再插入就是 LRU 的"移到队尾"。
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry;
  }

  set(key, entry, ttlMs) {
    if (!key || !Number.isFinite(ttlMs) || ttlMs <= 0) return entry;
    const size = entry.body.length;
    // 单条就超过总预算时直接不缓存，否则 trim 会为了放它一条把整个缓存清空。
    if (size > this.maxBytes) return entry;
    const existing = this.entries.get(key);
    if (existing) this.remove(key, existing);
    this.entries.set(key, { ...entry, size, expiresAt: this.now() + ttlMs });
    this.bytes += size;
    this.trim();
    return entry;
  }

  // 缓存未命中且同一个键已经有请求在算时，后到的请求等它的结果，而不是各自再查一遍库。
  // 冷缓存遇上并发（多人同时打开同一个历史区间）时这才是省力的地方。
  async load(key, ttlMs, build) {
    const hit = this.get(key);
    if (hit) return { entry: hit, state: 'hit' };
    if (key) {
      const pending = this.inFlight.get(key);
      if (pending) {
        this.coalesced += 1;
        return { entry: await pending, state: 'coalesced' };
      }
    }
    const promise = (async () => this.set(key, await build(), ttlMs))();
    if (key) {
      this.inFlight.set(key, promise);
      // 必须清理，否则一次失败会把这个键永久钉在 in-flight 表里，之后所有请求都拿到同一个错误。
      promise.catch(() => {}).then(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      });
    }
    return { entry: await promise, state: 'miss' };
  }

  remove(key, entry) {
    this.entries.delete(key);
    this.bytes -= entry.size;
  }

  trim() {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.remove(oldest.value, this.entries.get(oldest.value));
      this.evictions += 1;
    }
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  stats() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      evictions: this.evictions,
      expired: this.expired
    };
  }
}

// meta 的身份没有便宜的版本键可用（availableDates 一天才多一项，地图由定时任务刷新），
// 所以用一个带 TTL 的记忆化：既服务 /meta 路由，也服务每个历史请求的日期范围校验——
// 后者原先每次都要多查两次库。
class TtlMemo {
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : 30_000;
    this.now = options.now || (() => Date.now());
    this.expiresAt = 0;
    this.value = undefined;
    this.pending = null;
  }

  async resolve(load) {
    if (this.value !== undefined && this.expiresAt > this.now()) return this.value;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const value = await load();
        this.value = value;
        this.expiresAt = this.now() + this.ttlMs;
        return value;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  clear() {
    this.value = undefined;
    this.expiresAt = 0;
  }
}

module.exports = { ResponseCache, TtlMemo, ifNoneMatchSatisfied, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES };
