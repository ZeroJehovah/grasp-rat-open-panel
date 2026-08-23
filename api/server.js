'use strict';

const crypto = require('crypto');
const path = require('path');
const Fastify = require('fastify');
const fastifyCompress = require('@fastify/compress');

const { ProjectionEngine } = require('../domain/projector');
const { HISTORY_ROW_LIMITS, PostgresPanelStore } = require('../storage/postgres-store');
const { collectorHealth } = require('../collector/health');
const { BUSINESS_TIMEZONE, SCHEMA_VERSION, businessDateRange, isDateRangeCovered } = require('../domain/snapshot');

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

function buildStore(options = {}) {
  if (options.store) return options.store;
  if (options.connectionString || process.env.DATABASE_URL) return new PostgresPanelStore({ connectionString: options.connectionString || process.env.DATABASE_URL });
  return new ProjectionEngine(options);
}

async function buildServer(options = {}) {
  const store = buildStore(options);
  const app = Fastify({ logger: options.logger || false, trustProxy: true });
  await app.register(fastifyCompress, {
    threshold: 1024,
    encodings: ['br', 'gzip', 'deflate']
  });
  app.decorate('panelStore', store);
  app.decorate('collectorHealth', options.collectorHealth || (() => collectorHealth()));
  app.addHook('onRequest', async (request, reply) => {
    setCommonHeaders(reply);
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });

  app.get('/healthz', async (request, reply) => {
    const health = typeof app.collectorHealth === 'function' ? await app.collectorHealth() : null;
    return { ok: true, generatedAt: new Date().toISOString(), collector: health };
  });

  app.get('/api/v1/meta', async () => envelope(await store.getMeta()));

  app.get('/api/v1/realtime/version', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('CDN-Cache-Control', 'no-store');
    const latest = await store.getLatestVersion();
    return envelope({
      versionToken: latest?.version_token || latest?.snapshot_id || null,
      snapshotId: latest?.snapshot_id || null,
      observedAt: latest?.observed_at || null,
      serverDay: latest?.server_day || null,
      serverTick: latest?.server_tick ?? null
    });
  });

  app.get('/api/v1/realtime', async (request, reply) => {
    const payload = envelope(await store.getRealtime(parseVersion(request.query)));
    const tag = etagFor(stablePayload(payload));
    reply.header('ETag', tag);
    reply.header('Cache-Control', 'public, max-age=5, s-maxage=10, stale-while-revalidate=30');
    reply.header('CDN-Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
    if (request.headers['if-none-match'] === tag) return reply.code(304).send();
    if (payload.unchanged) return reply.code(200).send(payload);
    return payload;
  });

  app.get('/api/v1/history', async (request, reply) => {
    const from = String(request.query?.from || '');
    const to = String(request.query?.to || '');
    let range;
    try { range = businessDateRange(from, to); } catch (error) {
      return reply.code(400).send({ error: 'invalid_date_range', message: error.message, generatedAt: new Date().toISOString(), timezone: BUSINESS_TIMEZONE, schemaVersion: SCHEMA_VERSION });
    }
    const meta = await store.getMeta();
    const availableDates = Array.isArray(meta.availableDates) ? meta.availableDates : null;
    if (meta.earliestDate && range.from < meta.earliestDate || meta.latestDate && range.to > meta.latestDate || availableDates && !isDateRangeCovered(range, availableDates)) {
      return reply.code(416).send({ error: 'date_range_unavailable', earliestDate: meta.earliestDate, latestDate: meta.latestDate, generatedAt: new Date().toISOString(), timezone: BUSINESS_TIMEZONE, schemaVersion: SCHEMA_VERSION });
    }
    let history;
    try {
      history = await store.getHistory(range);
    } catch (error) {
      if (error?.code === 'history_result_limit') {
        return historyLimitReply(reply, error.resource, error.limit);
      }
      throw error;
    }
    for (const [resource, limit] of Object.entries(HISTORY_ROW_LIMITS)) {
      if (Array.isArray(history[resource]) && history[resource].length > limit) return historyLimitReply(reply, resource, limit);
    }
    const payload = envelope(history, range);
    const isClosed = Boolean(payload.closedThrough && payload.closedThrough >= range.to);
    const cache = isClosed ? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400' : 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
    reply.header('Cache-Control', cache);
    reply.header('CDN-Cache-Control', cache);
    const tag = etagFor(stablePayload(payload));
    reply.header('ETag', tag);
    if (request.headers['if-none-match'] === tag) return reply.code(304).send();
    return payload;
  });

  const realtimeResources = ['chat', 'map', 'players', 'kills'];
  for (const resource of realtimeResources) {
    const method = `getRealtime${resource[0].toUpperCase()}${resource.slice(1)}`;
    app.get(`/api/v1/realtime/${resource}`, async (request, reply) => {
      const payload = envelope(await store[method](parseVersion(request.query)), { scope: 'realtime', resource });
      const tag = etagFor(stablePayload(payload));
      reply.header('ETag', tag);
      reply.header('Cache-Control', 'public, max-age=5, s-maxage=10, stale-while-revalidate=30');
      reply.header('CDN-Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
      if (request.headers['if-none-match'] === tag) return reply.code(304).send();
      return payload;
    });
  }

  const historyResources = ['chat', 'players', 'kills'];
  for (const resource of historyResources) {
    const method = `getHistory${resource[0].toUpperCase()}${resource.slice(1)}`;
    app.get(`/api/v1/history/${resource}`, async (request, reply) => {
      const from = String(request.query?.from || '');
      const to = String(request.query?.to || '');
      let range;
      try { range = businessDateRange(from, to); } catch (error) {
        return reply.code(400).send({ error: 'invalid_date_range', message: error.message, resource, generatedAt: new Date().toISOString(), timezone: BUSINESS_TIMEZONE, schemaVersion: SCHEMA_VERSION });
      }
      const meta = await store.getMeta();
      const availableDates = Array.isArray(meta.availableDates) ? meta.availableDates : null;
      if (meta.earliestDate && range.from < meta.earliestDate || meta.latestDate && range.to > meta.latestDate || availableDates && !isDateRangeCovered(range, availableDates)) {
        return reply.code(416).send({ error: 'date_range_unavailable', resource, earliestDate: meta.earliestDate, latestDate: meta.latestDate, generatedAt: new Date().toISOString(), timezone: BUSINESS_TIMEZONE, schemaVersion: SCHEMA_VERSION });
      }
      let resourcePayload;
      try {
        resourcePayload = await store[method](range);
      } catch (error) {
        if (error?.code === 'history_result_limit') return historyLimitReply(reply, error.resource, error.limit);
        throw error;
      }
      const payload = envelope(resourcePayload, { scope: 'history', resource, from, to });
      const isClosed = Boolean(payload.closedThrough && payload.closedThrough >= to);
      const cache = isClosed ? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400' : 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
      reply.header('Cache-Control', cache);
      reply.header('CDN-Cache-Control', cache);
      const tag = etagFor(stablePayload(payload));
      reply.header('ETag', tag);
      if (request.headers['if-none-match'] === tag) return reply.code(304).send();
      return payload;
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

module.exports = { buildServer, startServer, envelope, etagFor, stablePayload, buildStore };
