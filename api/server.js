'use strict';

const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');
const Fastify = require('fastify');
const fastifyCompress = require('@fastify/compress');

const { ProjectionEngine } = require('../domain/projector');
const { HISTORY_ROW_LIMITS, PostgresPanelStore } = require('../storage/postgres-store');
const { collectorHealth } = require('../collector/health');
const { ResponseCache, TtlMemo, ifNoneMatchSatisfied, negotiateEncoding } = require('./cache');
const { BUSINESS_TIMEZONE, SCHEMA_VERSION, businessDateRange, isDateRangeCovered } = require('../domain/snapshot');

// 缓存键已经表达了失效条件，TTL 只是内存回收和迟到写入的上界。已结束的日期共享一条
// 缓存，唯一还能改变它的是 finalize-day 或迟到的投影补写，所以给它十分钟而不是永久。
const META_TTL_MS = 30_000;
const REALTIME_TTL_MS = 120_000;
const HISTORY_OPEN_TTL_MS = 120_000;
const HISTORY_CLOSED_TTL_MS = 600_000;

const VERSION_CACHE_CONTROL = 'no-store, no-cache, must-revalidate';
const META_CACHE_CONTROL = 'public, max-age=30, s-maxage=60, stale-while-revalidate=300';
const REALTIME_CACHE_CONTROL = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
const REALTIME_CDN_CACHE_CONTROL = 'public, max-age=10, stale-while-revalidate=30';
const HISTORY_OPEN_CACHE_CONTROL = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
const HISTORY_CLOSED_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';

// 压缩本来由 @fastify/compress 每次请求现做，1.1 MB 的响应体单这一步就要三十多毫秒，
// 比命中缓存后剩下的所有工作都贵。这里自己协商编码并把压缩结果缓存下来，参数刻意和
// 插件对齐（阈值 1024、brotli quality 4），这样客户端拿到的字节和之前一致。
// 一旦设了 Content-Encoding，插件的 onSend 会直接放行，不会二次压缩。
const COMPRESSION_ENCODINGS = Object.freeze(['br', 'gzip']);
const COMPRESSION_THRESHOLD = 1024;
const BROTLI_OPTIONS = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } };

function compressBody(encoding, body) {
  if (encoding === 'br') return zlib.brotliCompressSync(body, BROTLI_OPTIONS);
  if (encoding === 'gzip') return zlib.gzipSync(body);
  return null;
}

function etagFor(payload) {
  return `"${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}"`;
}

function stablePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const copy = { ...payload };
  delete copy.generatedAt;
  return copy;
}

function envelope(payload, extra = {}) {
  return {
    ...payload,
    ...extra,
    generatedAt: payload.generatedAt || new Date().toISOString(),
    timezone: payload.timezone || BUSINESS_TIMEZONE,
    schemaVersion: payload.schemaVersion || SCHEMA_VERSION
  };
}

function setCommonHeaders(reply) {
  reply.header('X-Panel-Timezone', BUSINESS_TIMEZONE);
  reply.header('X-Panel-Schema-Version', SCHEMA_VERSION);
  reply.header('Access-Control-Allow-Origin', process.env.PANEL_CORS_ORIGIN || '*');
  reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');
}

function parseVersion(query) {
  if (!query || query.version === undefined || query.version === '') return null;
  return String(query.version);
}

function historyLimitError(resource, limit) {
  const error = new Error(`history ${resource} result exceeds ${limit} rows`);
  error.code = 'history_result_limit';
  error.resource = resource;
  error.limit = limit;
  return error;
}

function historyLimitReply(reply, resource, limit) {
  return reply.code(413).header('Cache-Control', 'no-store').send({
    error: 'history_result_limit',
    resource,
    limit,
    generatedAt: new Date().toISOString(),
    timezone: BUSINESS_TIMEZONE,
    schemaVersion: SCHEMA_VERSION
  });
}

// 回滚兼容用的 store 和测试替身只实现自己需要的方法；缺少版本查询时退化为不分区缓存，
// 而不是让路由崩掉。
async function latestVersionOf(store) {
  if (!store || typeof store.getLatestVersion !== 'function') return null;
  return store.getLatestVersion();
}

function versionTokenOf(latest) {
  return latest?.version_token || latest?.snapshot_id || null;
}

function serverDayOf(latest) {
  return latest?.server_day ? String(latest.server_day).slice(0, 10) : null;
}

function buildStore(options = {}) {
  if (options.store) return options.store;
  if (options.connectionString || process.env.DATABASE_URL) return new PostgresPanelStore({ connectionString: options.connectionString || process.env.DATABASE_URL });
  return new ProjectionEngine(options);
}

function cacheOptions(options = {}) {
  if (options.cache === false || process.env.PANEL_CACHE_DISABLED === '1') return { disabled: true };
  const maxBytes = Number(options.cacheMaxBytes ?? process.env.PANEL_CACHE_MAX_BYTES);
  const maxEntries = Number(options.cacheMaxEntries ?? process.env.PANEL_CACHE_MAX_ENTRIES);
  return {
    disabled: false,
    maxBytes: Number.isFinite(maxBytes) ? maxBytes : undefined,
    maxEntries: Number.isFinite(maxEntries) ? maxEntries : undefined
  };
}

// 统一的响应出口：命中缓存时直接送出缓存好的响应体和 ETag，不再查库或重新序列化。
// key 为 null 表示这次响应不可共享（例如版本未变化的轻量响应，它取决于调用方带的令牌），
// 此时只是普通的构建-发送路径。
async function respondCached(request, reply, { cache, key, ttlMs, cacheControl, cdnCacheControl, build }) {
  const { entry, state } = await cache.load(key, ttlMs, async () => {
    const payload = await build();
    return { body: Buffer.from(JSON.stringify(payload), 'utf8'), etag: etagFor(stablePayload(payload)) };
  });
  reply.header('X-Panel-Cache', key ? state : 'bypass');
  reply.header('ETag', entry.etag);
  // 响应体随协商出的编码而变，Vary 必须在 304 之前就设上。
  reply.header('Vary', 'accept-encoding');
  if (cacheControl) {
    reply.header('Cache-Control', cacheControl);
    reply.header('CDN-Cache-Control', cdnCacheControl || cacheControl);
  }
  if (ifNoneMatchSatisfied(request.headers['if-none-match'], entry.etag)) return reply.code(304).send();
  reply.type('application/json; charset=utf-8');
  const encoding = request.headers['x-no-compression'] !== undefined || entry.body.length < COMPRESSION_THRESHOLD
    ? null
    : negotiateEncoding(request.headers['accept-encoding'], COMPRESSION_ENCODINGS);
  if (!encoding) return reply.send(entry.body);
  const encoded = cache.encodedFor(entry, encoding) || cache.noteEncoded(entry, encoding, compressBody(encoding, entry.body));
  reply.header('Content-Encoding', encoding);
  return reply.send(encoded);
}

async function buildServer(options = {}) {
  const store = buildStore(options);
  const cacheConfig = cacheOptions(options);
  const cache = new ResponseCache(cacheConfig);
  const metaMemo = new TtlMemo({ ttlMs: cacheConfig.disabled ? 0 : META_TTL_MS });
  const cacheKey = key => (cacheConfig.disabled ? null : key);
  const metaOf = () => metaMemo.resolve(() => store.getMeta());

  const app = Fastify({ logger: options.logger || false, trustProxy: true });
  await app.register(fastifyCompress, {
    threshold: 1024,
    encodings: ['br', 'gzip', 'deflate']
  });
  app.decorate('panelStore', store);
  app.decorate('panelCache', cache);
  app.decorate('collectorHealth', options.collectorHealth || (() => collectorHealth()));
  app.addHook('onRequest', async (request, reply) => {
    setCommonHeaders(reply);
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });

  app.get('/healthz', async (request, reply) => {
    const health = typeof app.collectorHealth === 'function' ? await app.collectorHealth() : null;
    const storeStats = typeof store.stats === 'function' ? store.stats() : null;
    return { ok: true, generatedAt: new Date().toISOString(), collector: health, cache: cache.stats(), store: storeStats };
  });

  app.get('/api/v1/meta', async (request, reply) => respondCached(request, reply, {
    cache,
    key: cacheKey('meta'),
    ttlMs: META_TTL_MS,
    cacheControl: META_CACHE_CONTROL,
    build: async () => envelope(await metaOf())
  }));

  app.get('/api/v1/realtime/version', async (request, reply) => {
    // 前端每 10 秒问一次这个接口来决定要不要拉 payload，它必须是唯一不缓存的读路径。
    reply.header('Cache-Control', VERSION_CACHE_CONTROL);
    reply.header('CDN-Cache-Control', 'no-store');
    const latest = await latestVersionOf(store);
    return envelope({
      versionToken: latest?.version_token || latest?.snapshot_id || null,
      snapshotId: latest?.snapshot_id || null,
      observedAt: latest?.observed_at || null,
      serverDay: latest?.server_day || null,
      serverTick: latest?.server_tick ?? null
    });
  });

  // 版本未变化的轻量响应取决于调用方带的令牌，绝不能和全量响应共用缓存键，否则
  // 一个带当前令牌的请求会把 `unchanged` 存进全量键，后面没带令牌的请求就拿不到数据。
  function realtimeCachePlan(request, latest) {
    const requested = parseVersion(request.query);
    const token = versionTokenOf(latest);
    const unchanged = Boolean(requested && token && requested === token);
    return { unchanged, token, storeVersion: unchanged ? requested : null };
  }

  app.get('/api/v1/realtime', async (request, reply) => {
    const plan = realtimeCachePlan(request, await latestVersionOf(store));
    return respondCached(request, reply, {
      cache,
      key: plan.unchanged ? null : cacheKey(`realtime:all:${plan.token || 'none'}`),
      ttlMs: REALTIME_TTL_MS,
      cacheControl: REALTIME_CACHE_CONTROL,
      cdnCacheControl: REALTIME_CDN_CACHE_CONTROL,
      build: async () => envelope(await store.getRealtime(plan.storeVersion))
    });
  });

  async function historyRangeOrReply(request, reply, resource) {
    const from = String(request.query?.from || '');
    const to = String(request.query?.to || '');
    let range;
    try {
      range = businessDateRange(from, to);
    } catch (error) {
      reply.code(400).send({ error: 'invalid_date_range', message: error.message, ...(resource ? { resource } : {}), generatedAt: new Date().toISOString(), timezone: BUSINESS_TIMEZONE, schemaVersion: SCHEMA_VERSION });
      return null;
    }
    const meta = await metaOf();
    const availableDates = Array.isArray(meta.availableDates) ? meta.availableDates : null;
    if (meta.earliestDate && range.from < meta.earliestDate || meta.latestDate && range.to > meta.latestDate || availableDates && !isDateRangeCovered(range, availableDates)) {
      reply.code(416).send({ error: 'date_range_unavailable', ...(resource ? { resource } : {}), earliestDate: meta.earliestDate, latestDate: meta.latestDate, generatedAt: new Date().toISOString(), timezone: BUSINESS_TIMEZONE, schemaVersion: SCHEMA_VERSION });
      return null;
    }
    const latest = await latestVersionOf(store);
    const latestDay = serverDayOf(latest);
    // 已结束的区间不会随版本变化，所以它们共享一条缓存；含今天的区间每个版本一份。
    const closed = Boolean(latestDay && range.to < latestDay);
    return { range, closed, token: versionTokenOf(latest) };
  }

  function historyCacheFields(plan, resource) {
    return {
      key: cacheKey(`history:${resource}:${plan.range.from}:${plan.range.to}:${plan.closed ? 'closed' : plan.token || 'none'}`),
      ttlMs: plan.closed ? HISTORY_CLOSED_TTL_MS : HISTORY_OPEN_TTL_MS,
      cacheControl: plan.closed ? HISTORY_CLOSED_CACHE_CONTROL : HISTORY_OPEN_CACHE_CONTROL
    };
  }

  app.get('/api/v1/history', async (request, reply) => {
    const plan = await historyRangeOrReply(request, reply, null);
    if (!plan) return reply;
    try {
      return await respondCached(request, reply, {
        cache,
        ...historyCacheFields(plan, 'all'),
        build: async () => {
          const history = await store.getHistory(plan.range);
          for (const [resource, limit] of Object.entries(HISTORY_ROW_LIMITS)) {
            if (Array.isArray(history[resource]) && history[resource].length > limit) throw historyLimitError(resource, limit);
          }
          return envelope(history, plan.range);
        }
      });
    } catch (error) {
      if (error?.code === 'history_result_limit') return historyLimitReply(reply, error.resource, error.limit);
      throw error;
    }
  });

  const realtimeResources = ['chat', 'map', 'players', 'kills'];
  for (const resource of realtimeResources) {
    const method = `getRealtime${resource[0].toUpperCase()}${resource.slice(1)}`;
    app.get(`/api/v1/realtime/${resource}`, async (request, reply) => {
      const plan = realtimeCachePlan(request, await latestVersionOf(store));
      return respondCached(request, reply, {
        cache,
        key: plan.unchanged ? null : cacheKey(`realtime:${resource}:${plan.token || 'none'}`),
        ttlMs: REALTIME_TTL_MS,
        cacheControl: REALTIME_CACHE_CONTROL,
        cdnCacheControl: REALTIME_CDN_CACHE_CONTROL,
        build: async () => envelope(await store[method](plan.storeVersion), { scope: 'realtime', resource })
      });
    });
  }

  const historyResources = ['chat', 'players', 'kills'];
  for (const resource of historyResources) {
    const method = `getHistory${resource[0].toUpperCase()}${resource.slice(1)}`;
    app.get(`/api/v1/history/${resource}`, async (request, reply) => {
      const plan = await historyRangeOrReply(request, reply, resource);
      if (!plan) return reply;
      try {
        return await respondCached(request, reply, {
          cache,
          ...historyCacheFields(plan, resource),
          build: async () => envelope(await store[method](plan.range), { scope: 'history', resource, from: plan.range.from, to: plan.range.to })
        });
      } catch (error) {
        if (error?.code === 'history_result_limit') return historyLimitReply(reply, error.resource, error.limit);
        throw error;
      }
    });
  }

  if (options.staticDirectory) {
    try {
      const fastifyStatic = require('@fastify/static');
      await app.register(fastifyStatic, { root: path.resolve(options.staticDirectory), prefix: '/', wildcard: true });
      app.setNotFoundHandler((request, reply) => {
        if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
        return reply.code(404).send({ error: 'not_found' });
      });
    } catch (error) {
      if (options.requireStatic) throw error;
    }
  }
  return app;
}

async function startServer(options = {}) {
  const app = await buildServer(options);
  const host = options.host || process.env.PANEL_HOST || '127.0.0.1';
  const port = Number(options.port || process.env.PANEL_PORT || 19317);
  await app.listen({ host, port });
  return app;
}

if (require.main === module) {
  startServer({ staticDirectory: process.env.PANEL_STATIC_DIR || path.resolve(__dirname, '../frontend/dist') })
    .then(app => {
      const shutdown = async () => { await app.close(); if (app.panelStore?.close) await app.panelStore.close(); };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    })
    .catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
}

module.exports = { buildServer, startServer, envelope, etagFor, stablePayload, buildStore, ifNoneMatchSatisfied };
