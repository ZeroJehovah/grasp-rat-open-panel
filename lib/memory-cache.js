'use strict';

// 进程内 LRU 缓存核心：按"权重"和条目数双重设限，带 TTL 过期和并发合并。
//
// 权重的单位由子类的 weigh() 定义。响应缓存按字节计（它存的就是 Buffer），历史分片
// 缓存按行数乘以估算的每行字节计——那里存的是 pg 行对象，精确大小拿不到，估算值只用来
// 给内存设一个上界。
//
// 失效靠缓存键，不靠时间：键必须自己表达"什么变了"（版本令牌、日期是否已结束）。TTL
// 只是内存回收和键表达不了的迟到写入（finalize-day 补写、refresh-map）的上界。
//
// 只有读进程使用它。写入走独立的 projector 进程，所以这里不需要写失效。

const DEFAULT_MAX_WEIGHT = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 256;

class MemoryCache {
  constructor(options = {}) {
    this.maxWeight = Number.isFinite(Number(options.maxWeight)) ? Number(options.maxWeight) : DEFAULT_MAX_WEIGHT;
    this.maxEntries = Number.isFinite(Number(options.maxEntries)) ? Number(options.maxEntries) : DEFAULT_MAX_ENTRIES;
    this.now = options.now || (() => Date.now());
    this.entries = new Map();
    this.inFlight = new Map();
    this.weight = 0;
    this.hits = 0;
    this.misses = 0;
    this.coalesced = 0;
    this.evictions = 0;
    this.expired = 0;
  }

  // 子类覆盖。默认按条目计数，只有 maxEntries 起作用。
  weigh() {
    return 1;
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
    const size = this.weigh(entry);
    // 单条就超过总预算时直接不缓存，否则 trim 会为了放它一条把整个缓存清空。
    if (size > this.maxWeight) return entry;
    const existing = this.entries.get(key);
    if (existing) this.remove(key, existing);
    // 返回存进去的那个副本，调用方拿到的就是缓存里的同一个对象：响应缓存要在命中后
    // 往它上面追加压缩结果，追加的字节必须能记回同一条的权重里。
    const stored = { ...entry, size, expiresAt: this.now() + ttlMs };
    this.entries.set(key, stored);
    this.weight += size;
    this.trim();
    return stored;
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

  // 条目入缓存之后才算出来的附加内容（压缩结果）要把权重补记进去，否则字节预算会
  // 少算。没有 size 的条目是 set() 拒收的旁路条目，它不在缓存里，不参与计费。
  addWeight(entry, delta) {
    if (!entry || !Number.isFinite(entry.size) || !(delta > 0)) return;
    entry.size += delta;
    this.weight += delta;
    this.trim();
  }

  remove(key, entry) {
    this.entries.delete(key);
    this.weight -= entry.size;
  }

  trim() {
    while (this.entries.size > this.maxEntries || this.weight > this.maxWeight) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.remove(oldest.value, this.entries.get(oldest.value));
      this.evictions += 1;
    }
  }

  clear() {
    this.entries.clear();
    this.inFlight.clear();
    this.weight = 0;
  }

  stats() {
    return {
      entries: this.entries.size,
      weight: this.weight,
      maxWeight: this.maxWeight,
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      evictions: this.evictions,
      expired: this.expired
    };
  }
}

// 有界并发的 map。按天分片以后一个跨月请求会变成三十次小查询，不限并发就会把连接池
// 抽干，连实时接口一起拖慢。
async function mapWithConcurrency(items, limit, worker) {
  const list = Array.from(items);
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length));
  let cursor = 0;
  const runners = Array.from({ length: width }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(list[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = { MemoryCache, mapWithConcurrency, DEFAULT_MAX_WEIGHT, DEFAULT_MAX_ENTRIES };
