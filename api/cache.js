'use strict';

// 进程内响应缓存。缓存的是"序列化后的响应体 + ETag + 压缩结果"，命中时既不查库、也不
// 重新映射行、序列化、哈希和压缩。
//
// 失效靠缓存键，不靠时间：实时资源按版本令牌分区，历史资源按日期范围加"该区间是否
// 已结束"分区。TTL 只是兜底——它回收内存，并给键表达不了的迟到写入（finalize-day
// 补写已结束日期、refresh-map 更新地图）设一个上界。
//
// 只有 API 进程使用它。写入走独立的 projector 进程，所以这里不需要写失效。

const { MemoryCache, DEFAULT_MAX_WEIGHT, DEFAULT_MAX_ENTRIES } = require('../lib/memory-cache');

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

// 自己解析 Accept-Encoding，是为了在缓存命中时能直接送出缓存好的压缩结果。
// 判断不了就返回 null，退回 @fastify/compress 每次现压——失败方向是"慢一点"，不是"错"。
function negotiateEncoding(header, candidates) {
  if (!header || !Array.isArray(candidates) || candidates.length === 0) return null;
  const weights = new Map();
  for (const part of String(header).toLowerCase().split(',')) {
    const [name, ...params] = part.split(';');
    const token = name.trim();
    if (!token) continue;
    let quality = 1;
    for (const param of params) {
      if (!/^\s*q\s*=/.test(param)) continue;
      // 写了 q 但解析不出来时按"不接受"处理：宁可退回插件现压，也不要把客户端没明确
      // 接受的编码发出去。
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param);
      quality = match ? Number(match[1]) : 0;
    }
    if (!Number.isFinite(quality)) quality = 0;
    // x-gzip 是 gzip 的历史别名，@fastify/compress 也这么归一化。
    weights.set(token === 'x-gzip' ? 'gzip' : token, quality);
  }
  const wildcard = weights.has('*') ? weights.get('*') : null;
  let best = null;
  for (const candidate of candidates) {
    const quality = weights.has(candidate) ? weights.get(candidate) : wildcard;
    if (quality === null || !(quality > 0)) continue;
    // 严格大于：质量相同时按 candidates 的顺序取偏好靠前的那个。
    if (!best || quality > best.quality) best = { encoding: candidate, quality };
  }
  return best ? best.encoding : null;
}

class ResponseCache extends MemoryCache {
  constructor(options = {}) {
    super({ ...options, maxWeight: options.maxBytes });
    this.compressions = 0;
    this.encodedBytes = 0;
  }

  weigh(entry) {
    return entry.body.length;
  }

  get bytes() {
    return this.weight;
  }

  get maxBytes() {
    return this.maxWeight;
  }

  // 压缩结果按编码挂在条目上。同一条响应最多两份（br 和 gzip），字节要补记进权重，
  // 否则一个装满压缩结果的缓存会悄悄超出预算。
  noteEncoded(entry, encoding, buffer) {
    if (!entry) return buffer;
    if (!entry.encoded) entry.encoded = new Map();
    entry.encoded.set(encoding, buffer);
    this.compressions += 1;
    this.encodedBytes += buffer.length;
    this.addWeight(entry, buffer.length);
    return buffer;
  }

  encodedFor(entry, encoding) {
    return entry?.encoded?.get(encoding) || null;
  }

  stats() {
    const base = super.stats();
    return {
      entries: base.entries,
      bytes: base.weight,
      maxBytes: base.maxWeight,
      hits: base.hits,
      misses: base.misses,
      coalesced: base.coalesced,
      evictions: base.evictions,
      expired: base.expired,
      compressions: this.compressions,
      encodedBytes: this.encodedBytes
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

module.exports = {
  ResponseCache,
  TtlMemo,
  ifNoneMatchSatisfied,
  negotiateEncoding,
  DEFAULT_MAX_BYTES: DEFAULT_MAX_WEIGHT,
  DEFAULT_MAX_ENTRIES
};
