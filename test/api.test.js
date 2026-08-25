'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { ProjectionEngine } = require('../domain/projector');
const { buildServer } = require('../api/server');
const { PostgresPanelStore, rowToPlayer } = require('../storage/postgres-store');

const nullDropPlayer = rowToPlayer({
  user_id: 7,
  current_name: 'null-drop',
  online: true,
  server_day: '2026-08-22',
  state: { death_drop_coins: null }
}, { kills: 0, deaths: 0 }, { currentDay: '2026-08-22' });
assert.strictEqual(nullDropPlayer.drop, null);
const mappedDetailPlayer = rowToPlayer({
  user_id: 8,
  current_name: 'detail-player',
  online: true,
  server_day: '2026-08-22',
  state: { invulnerable_remaining_secs: 12, death_loss_preview: 3 }
}, { kills: 0, deaths: 0 }, { currentDay: '2026-08-22' });
assert.strictEqual(mappedDetailPlayer.state.invulnerableRemainingSecs, 12);
assert.strictEqual(mappedDetailPlayer.state.loss, 3);

function fixture() {
  const fields = {
    entity_id: 1, user_id: 1, name: 'api-user', x: 0, y: 0, vx: 0, vy: 0, cell: [0, 0], hp: 100, max_hp: 100,
    invulnerable_until_tick: 0, invulnerable_remaining_ticks: 0, invulnerable_remaining_secs: 0,
    stamina_5s_remaining_milli: 10000, stamina_1h_remaining_milli: 3000000, stamina_1d_remaining_milli: 20000000,
    stamina_5s_limit_milli: 10000, stamina_1h_limit_milli: 3000000, stamina_1d_limit_milli: 20000000, coins: 1000,
    death_drop_coins: 10, death_reward_preview: 1, death_loss_preview: 0, death_total_loss_preview: 0, daily_budget_day_key_utc8: 20687,
    external_balance_snapshot: 1, coin_value_snapshot: 1, reward_pool_limit: 1, reward_dropped_today: 0, reward_remaining_today: 1,
    death_loss_pool_limit: 1, death_lost_today: 0, death_loss_remaining_today: 1, active_join_count: 0, passive_join_count: 1,
    death_count: 0, waiting_revive_count: 0, waiting_revive: false, revive_at_tick: 0, active_join_ticks: [], passive_join_ticks: [1],
    death_ticks: [], visible: 'Visible', joined: 'InGame', current_join_mode: 'Passive', life: 'Alive'
  };
  return Buffer.from(JSON.stringify({ type: 'snapshot', tick: 100, total_entities: 1, in_game: 1, visible: 1, occupied_cells: 1, entities: [fields], bullets: [], coin_drops: [], messages: [] }));
}

(async () => {
  const store = new ProjectionEngine({ minSteadyEntities: 1 });
  store.applyObservation(fixture(), { observationId: 'api-fixture', observedAt: '2026-08-22T00:01:00+08:00', statusCode: 200 });
  const app = await buildServer({ store });
  const meta = await app.inject({ method: 'GET', url: '/api/v1/meta' });
  assert.strictEqual(meta.statusCode, 200);
  assert.strictEqual(meta.json().timezone, 'Asia/Shanghai');
  assert.deepStrictEqual(meta.json().presetRanges.today, { from: '2026-08-22', to: '2026-08-22' });
  assert.strictEqual(meta.json().presetRanges.yesterday, null);
  const version = await app.inject({ method: 'GET', url: '/api/v1/realtime/version' });
  assert.strictEqual(version.headers['cache-control'], 'no-store, no-cache, must-revalidate');
  const realtime = await app.inject({ method: 'GET', url: '/api/v1/realtime' });
  assert.strictEqual(realtime.statusCode, 200);
  assert.strictEqual(realtime.json().players.length, 1);
  const cached = await app.inject({ method: 'GET', url: '/api/v1/realtime', headers: { 'if-none-match': realtime.headers.etag } });
  assert.strictEqual(cached.statusCode, 304);
  const unchanged = await app.inject({ method: 'GET', url: `/api/v1/realtime?version=${encodeURIComponent(realtime.json().versionToken)}` });
  assert.strictEqual(unchanged.json().unchanged, true);
  const realtimeResources = {
    chat: ['messages'],
    map: ['map', 'players'],
    players: ['players'],
    kills: ['kills']
  };
  for (const [resource, allowedArrays] of Object.entries(realtimeResources)) {
    const response = await app.inject({ method: 'GET', url: `/api/v1/realtime/${resource}` });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.json().scope, 'realtime');
    assert.strictEqual(response.json().resource, resource);
    for (const field of ['players', 'messages', 'kills']) {
      if (!allowedArrays.includes(field)) assert.strictEqual(Object.prototype.hasOwnProperty.call(response.json(), field), false, `${resource} leaked ${field}`);
    }
    if (resource === 'map') assert.deepStrictEqual(Object.keys(response.json().players[0]).sort(), ['drop', 'name', 'online', 'state', 'userId']);
    const resourceCached = await app.inject({ method: 'GET', url: `/api/v1/realtime/${resource}`, headers: { 'if-none-match': response.headers.etag } });
    assert.strictEqual(resourceCached.statusCode, 304);
    const unchangedResource = await app.inject({ method: 'GET', url: `/api/v1/realtime/${resource}?version=${encodeURIComponent(response.json().versionToken)}` });
    assert.strictEqual(unchangedResource.json().unchanged, true);
  }
  const invalidDate = await app.inject({ method: 'GET', url: '/api/v1/history?from=2026-02-30&to=2026-02-30' });
  assert.strictEqual(invalidDate.statusCode, 400);
  const tooLong = await app.inject({ method: 'GET', url: '/api/v1/history?from=2026-06-21&to=2026-08-22' });
  assert.strictEqual(tooLong.statusCode, 400);
  const history = await app.inject({ method: 'GET', url: '/api/v1/history?from=2026-08-22&to=2026-08-22' });
  assert.strictEqual(history.statusCode, 200);
  assert.strictEqual(history.json().from, '2026-08-22');
  for (const resource of ['chat', 'players', 'kills']) {
    const response = await app.inject({ method: 'GET', url: `/api/v1/history/${resource}?from=2026-08-22&to=2026-08-22` });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.json().scope, 'history');
    assert.strictEqual(response.json().resource, resource);
    const expectedField = resource === 'chat' ? 'messages' : resource;
    assert.deepStrictEqual(Object.keys(response.json()).filter(key => ['messages', 'players', 'kills'].includes(key)), [expectedField]);
  }
  const postgresCalls = [];
  const fakePool = {
    query: async (text, values) => {
      postgresCalls.push({ text, values });
      if (text.includes('FROM snapshot_versions ORDER BY observed_at DESC')) return { rows: [{ snapshot_id: 'pg-s1', version_token: 'pg-v1', server_day: '2026-08-22', server_tick: 1, observed_at: '2026-08-22T00:00:00.000Z' }] };
      if (text.includes('FROM map_metadata')) return { rows: [{ payload: { id: 'pg-map', version: 1, bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 }, center: { x: 0, y: 0 }, directions: [], metersPerGameUnit: 1 } }] };
      return { rows: [] };
    }
  };
  const postgresStore = new PostgresPanelStore({ pool: fakePool, engine: new ProjectionEngine({ minSteadyEntities: 1 }) });
  await postgresStore.getRealtimeChat('old-token');
  await postgresStore.getRealtimeMap('old-token');
  await postgresStore.getRealtimePlayers('old-token');
  await postgresStore.getRealtimeKills('old-token');
  await postgresStore.getHistoryChat({ from: '2026-08-22', to: '2026-08-22' });
  await postgresStore.getHistoryPlayers({ from: '2026-08-22', to: '2026-08-22' });
  await postgresStore.getHistoryKills({ from: '2026-08-22', to: '2026-08-22' });
  assert.ok(postgresCalls.some(call => call.text.includes('message_events') && call.values?.[0] === '2026-08-22'));
  assert.ok(postgresCalls.some(call => call.text.includes('kill_events') && call.values?.[0] === '2026-08-22'));
  // 玩家维度只按天缓存"当天每个用户的战绩和配额"，排名和 drop 每次现查。
  assert.ok(postgresCalls.some(call => call.text.includes('FULL JOIN') && call.text.includes('player_daily_quota') && call.values?.[0] === '2026-08-22'));
  assert.ok(postgresCalls.some(call => call.text.includes('death_drop_coins') && call.values?.[0] === '2026-08-22' && call.values?.[1] === 50));
  assert.ok(!postgresCalls.some(call => call.text.includes('ranged_quota')), 'the default history path must not fall back to the range query');
  // 同一天再问一次只应该命中分片缓存，不再查库。
  const messageQueriesBefore = postgresCalls.filter(call => call.text.includes('message_events')).length;
  await postgresStore.getHistoryChat({ from: '2026-08-22', to: '2026-08-22' });
  assert.strictEqual(postgresCalls.filter(call => call.text.includes('message_events')).length, messageQueriesBefore, 'a cached day fragment must not re-query');
  assert.ok(postgresStore.stats().historyDays.hits > 0);

  // 逃生口：关掉按天分片以后必须退回原来的整区间查询。
  const directCalls = [];
  const directStore = new PostgresPanelStore({
    pool: { query: async (text, values) => { directCalls.push({ text, values }); return { rows: [] }; } },
    engine: new ProjectionEngine({ minSteadyEntities: 1 }),
    historyDayCache: false
  });
  await directStore.getHistoryPlayers({ from: '2026-08-22', to: '2026-08-22' });
  await directStore.getHistoryChat({ from: '2026-08-22', to: '2026-08-22' });
  assert.ok(directCalls.some(call => call.text.includes('ranged_quota')), 'historyDayCache=false must use the range query');
  assert.ok(directCalls.some(call => call.text.includes('message_events') && call.values?.[1] === '2026-08-22'));
  const staticApp = await buildServer({ store, staticDirectory: path.resolve(__dirname, '../frontend'), requireStatic: true });
  const staticAsset = await staticApp.inject({ method: 'GET', url: '/src/App.tsx' });
  assert.strictEqual(staticAsset.statusCode, 200);
  assert.match(staticAsset.body, /export default function App/);
  await staticApp.close();
  const compressedApp = await buildServer({ store: {
    getMeta: async () => ({ earliestDate: '2026-08-22', latestDate: '2026-08-22' }),
    getHistory: async () => ({ from: '2026-08-22', to: '2026-08-22', timezone: 'Asia/Shanghai', closedThrough: null, players: Array.from({ length: 100 }, (_, index) => ({ userId: index, name: 'compression-fixture-' + 'x'.repeat(32) })), messages: [], kills: [], dailyQuota: [], stats: [] })
  } });
  const compressedUrl = '/api/v1/history?from=2026-08-22&to=2026-08-22';
  const compressedHistory = await compressedApp.inject({ method: 'GET', url: compressedUrl, headers: { 'accept-encoding': 'gzip' } });
  assert.strictEqual(compressedHistory.headers['content-encoding'], 'gzip');
  assert.strictEqual(JSON.parse(zlib.gunzipSync(compressedHistory.rawPayload).toString('utf8')).from, '2026-08-22');

  // 压缩结果也进缓存：同一条响应每种编码只压一次。压缩曾经是命中缓存后最贵的一步，
  // 1.1 MB 的响应体单 brotli 就要三十多毫秒，而且每个请求都要重做一遍。
  const identity = await compressedApp.inject({ method: 'GET', url: compressedUrl });
  assert.strictEqual(identity.headers['content-encoding'], undefined);
  const brotli = await compressedApp.inject({ method: 'GET', url: compressedUrl, headers: { 'accept-encoding': 'gzip, br' } });
  assert.strictEqual(brotli.headers['content-encoding'], 'br', 'br must win over gzip when both are acceptable');
  assert.strictEqual(brotli.headers.vary, 'accept-encoding');
  assert.strictEqual(zlib.brotliDecompressSync(brotli.rawPayload).toString('utf8'), identity.body, 'the compressed body must decode to the identity body');
  assert.strictEqual(zlib.gunzipSync(compressedHistory.rawPayload).toString('utf8'), identity.body);
  await compressedApp.inject({ method: 'GET', url: compressedUrl, headers: { 'accept-encoding': 'br' } });
  await compressedApp.inject({ method: 'GET', url: compressedUrl, headers: { 'accept-encoding': 'gzip' } });
  assert.strictEqual(compressedApp.panelCache.stats().compressions, 2, 'each encoding must be compressed once and then reused');
  assert.ok(compressedApp.panelCache.stats().encodedBytes > 0);
  // 认不出来的编码退回插件处理，插件只提供 br/gzip/deflate，所以结果是不压缩。
  const unknownEncoding = await compressedApp.inject({ method: 'GET', url: compressedUrl, headers: { 'accept-encoding': 'zstd' } });
  assert.strictEqual(unknownEncoding.headers['content-encoding'], undefined);
  assert.strictEqual(unknownEncoding.body, identity.body);
  const suppressed = await compressedApp.inject({ method: 'GET', url: compressedUrl, headers: { 'accept-encoding': 'br', 'x-no-compression': '1' } });
  assert.strictEqual(suppressed.headers['content-encoding'], undefined);
  // 条件请求仍然先于压缩返回 304，304 不能带 Content-Encoding。
  const conditionalCompressed = await compressedApp.inject({ method: 'GET', url: compressedUrl, headers: { 'accept-encoding': 'br', 'if-none-match': `W/${identity.headers.etag}` } });
  assert.strictEqual(conditionalCompressed.statusCode, 304);
  assert.strictEqual(conditionalCompressed.headers['content-encoding'], undefined);
  assert.strictEqual(conditionalCompressed.headers.vary, 'accept-encoding');
  assert.strictEqual(compressedApp.panelCache.stats().compressions, 2);
  // 小响应体不压缩：阈值和 @fastify/compress 的配置一致。
  const smallMeta = await compressedApp.inject({ method: 'GET', url: '/api/v1/meta', headers: { 'accept-encoding': 'br' } });
  assert.ok(smallMeta.rawPayload.length < 1024);
  assert.strictEqual(smallMeta.headers['content-encoding'], undefined);
  await compressedApp.close();
  const cachedHistory = await app.inject({ method: 'GET', url: '/api/v1/history?from=2026-08-22&to=2026-08-22', headers: { 'if-none-match': history.headers.etag } });
  assert.strictEqual(cachedHistory.statusCode, 304);

  // Cloudflare 把强 ETag 改写成弱形式，浏览器原样回传。修复前服务端精确比较，公网上
  // 每次条件请求都在全量下载。
  const weakEtag = `W/${realtime.headers.etag}`;
  const weakRealtime = await app.inject({ method: 'GET', url: '/api/v1/realtime', headers: { 'if-none-match': weakEtag } });
  assert.strictEqual(weakRealtime.statusCode, 304, 'a weak ETag must satisfy If-None-Match');
  const weakList = await app.inject({ method: 'GET', url: '/api/v1/realtime', headers: { 'if-none-match': `W/"stale", ${realtime.headers.etag}` } });
  assert.strictEqual(weakList.statusCode, 304);
  const starMatch = await app.inject({ method: 'GET', url: '/api/v1/realtime', headers: { 'if-none-match': '*' } });
  assert.strictEqual(starMatch.statusCode, 304);
  const weakHistory = await app.inject({ method: 'GET', url: '/api/v1/history/chat?from=2026-08-22&to=2026-08-22' });
  const weakHistoryRepeat = await app.inject({ method: 'GET', url: '/api/v1/history/chat?from=2026-08-22&to=2026-08-22', headers: { 'if-none-match': `W/${weakHistory.headers.etag}` } });
  assert.strictEqual(weakHistoryRepeat.statusCode, 304);

  // meta 之前既没有 ETag 也没有 Cache-Control。
  const metaRepeat = await app.inject({ method: 'GET', url: '/api/v1/meta' });
  assert.ok(metaRepeat.headers.etag, 'meta must carry an ETag');
  assert.strictEqual(metaRepeat.headers['cache-control'], 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
  assert.strictEqual(metaRepeat.headers['x-panel-cache'], 'hit');
  const metaCached = await app.inject({ method: 'GET', url: '/api/v1/meta', headers: { 'if-none-match': `W/${metaRepeat.headers.etag}` } });
  assert.strictEqual(metaCached.statusCode, 304);

  const realtimeRepeat = await app.inject({ method: 'GET', url: '/api/v1/realtime/chat' });
  assert.strictEqual(realtimeRepeat.headers['x-panel-cache'], 'hit');
  assert.strictEqual(realtimeRepeat.headers['content-type'], 'application/json; charset=utf-8');
  assert.strictEqual(realtimeRepeat.headers['cache-control'], 'public, max-age=5, s-maxage=10, stale-while-revalidate=30');
  assert.strictEqual(realtimeRepeat.headers['cdn-cache-control'], 'public, max-age=10, stale-while-revalidate=30');
  assert.ok(app.panelCache.stats().hits > 0);

  // 版本未变化的轻量响应绝不能落进全量响应的缓存键，否则后面没带令牌的请求就没数据了。
  const chatFull = await app.inject({ method: 'GET', url: '/api/v1/realtime/chat' });
  const currentToken = chatFull.json().versionToken;
  const chatUnchanged = await app.inject({ method: 'GET', url: `/api/v1/realtime/chat?version=${encodeURIComponent(currentToken)}` });
  assert.strictEqual(chatUnchanged.json().unchanged, true);
  assert.strictEqual(chatUnchanged.headers['x-panel-cache'], 'bypass');
  const chatAfterUnchanged = await app.inject({ method: 'GET', url: '/api/v1/realtime/chat' });
  assert.strictEqual(chatAfterUnchanged.json().unchanged, undefined, 'the unchanged reply must not poison the shared cache entry');
  assert.ok(Array.isArray(chatAfterUnchanged.json().messages));
  // 过期令牌拿到的是全量响应，并且和不带令牌的请求共用同一条缓存。
  const staleToken = await app.inject({ method: 'GET', url: '/api/v1/realtime/chat?version=stale-token' });
  assert.strictEqual(staleToken.json().unchanged, undefined);
  assert.strictEqual(staleToken.headers.etag, chatAfterUnchanged.headers.etag);
  await app.close();

  // 版本令牌变化必须让实时缓存失效。
  let mutableToken = 'v1';
  let mutableMessages = [{ message_id: 'm1' }];
  const mutableApp = await buildServer({ store: {
    getMeta: async () => ({ earliestDate: '2026-08-22', latestDate: '2026-08-22', availableDates: ['2026-08-22'] }),
    getLatestVersion: async () => ({ version_token: mutableToken, snapshot_id: mutableToken, server_day: '2026-08-22' }),
    getRealtimeChat: async () => ({ unchanged: false, versionToken: mutableToken, messages: mutableMessages })
  } });
  const beforeBump = await mutableApp.inject({ method: 'GET', url: '/api/v1/realtime/chat' });
  assert.deepStrictEqual(beforeBump.json().messages, [{ message_id: 'm1' }]);
  assert.strictEqual(beforeBump.headers['x-panel-cache'], 'miss');
  mutableToken = 'v2';
  mutableMessages = [{ message_id: 'm2' }];
  const afterBump = await mutableApp.inject({ method: 'GET', url: '/api/v1/realtime/chat' });
  assert.strictEqual(afterBump.headers['x-panel-cache'], 'miss', 'a new version token must miss the cache');
  assert.deepStrictEqual(afterBump.json().messages, [{ message_id: 'm2' }], 'a new version token must not serve stale data');
  assert.notStrictEqual(afterBump.headers.etag, beforeBump.headers.etag);
  await mutableApp.close();

  // 已结束的历史区间和含今天的区间必须分键，缓存头也不同。
  const rangeApp = await buildServer({ store: {
    getMeta: async () => ({ earliestDate: '2026-08-20', latestDate: '2026-08-22', availableDates: ['2026-08-20', '2026-08-21', '2026-08-22'] }),
    getLatestVersion: async () => ({ version_token: 'range-v1', server_day: '2026-08-22' }),
    getHistoryChat: async range => ({ from: range.from, to: range.to, closedThrough: range.to < '2026-08-22' ? range.to : null, messages: [{ message_id: `m-${range.to}` }] })
  } });
  const closedRange = await rangeApp.inject({ method: 'GET', url: '/api/v1/history/chat?from=2026-08-20&to=2026-08-20' });
  assert.strictEqual(closedRange.headers['cache-control'], 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
  assert.strictEqual(closedRange.headers['cdn-cache-control'], 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
  const openRange = await rangeApp.inject({ method: 'GET', url: '/api/v1/history/chat?from=2026-08-21&to=2026-08-22' });
  assert.strictEqual(openRange.headers['cache-control'], 'public, max-age=5, s-maxage=10, stale-while-revalidate=30');
  assert.deepStrictEqual(openRange.json().messages, [{ message_id: 'm-2026-08-22' }], 'a different range must not reuse another range cache entry');
  const closedRepeat = await rangeApp.inject({ method: 'GET', url: '/api/v1/history/chat?from=2026-08-20&to=2026-08-20' });
  assert.strictEqual(closedRepeat.headers['x-panel-cache'], 'hit');
  assert.deepStrictEqual(closedRepeat.json().messages, [{ message_id: 'm-2026-08-20' }]);
  await rangeApp.close();

  // PANEL_CACHE_DISABLED 的等价开关：每次请求都重新构建，但 ETag/304 仍然有效。
  let bypassBuilds = 0;
  const bypassApp = await buildServer({ cache: false, store: {
    getMeta: async () => ({ earliestDate: '2026-08-22', latestDate: '2026-08-22', availableDates: ['2026-08-22'] }),
    getLatestVersion: async () => ({ version_token: 'bypass-v1', server_day: '2026-08-22' }),
    getRealtimeChat: async () => { bypassBuilds += 1; return { unchanged: false, versionToken: 'bypass-v1', messages: [] }; }
  } });
  const bypassFirst = await bypassApp.inject({ method: 'GET', url: '/api/v1/realtime/chat' });
  const bypassSecond = await bypassApp.inject({ method: 'GET', url: '/api/v1/realtime/chat' });
  assert.strictEqual(bypassBuilds, 2, 'a disabled cache must rebuild every request');
  assert.strictEqual(bypassSecond.headers['x-panel-cache'], 'bypass');
  assert.strictEqual(bypassApp.panelCache.stats().entries, 0);
  const bypassConditional = await bypassApp.inject({ method: 'GET', url: '/api/v1/realtime/chat', headers: { 'if-none-match': `W/${bypassFirst.headers.etag}` } });
  assert.strictEqual(bypassConditional.statusCode, 304);
  await bypassApp.close();

  const oversizedApp = await buildServer({ store: {
    getMeta: async () => ({ earliestDate: '2026-08-22', latestDate: '2026-08-22' }),
    getHistory: async () => ({ from: '2026-08-22', to: '2026-08-22', timezone: 'Asia/Shanghai', closedThrough: null, players: Array.from({ length: 5_001 }, () => ({})), messages: [], kills: [], dailyQuota: [], stats: [] })
  } });
  const oversized = await oversizedApp.inject({ method: 'GET', url: '/api/v1/history?from=2026-08-22&to=2026-08-22' });
  assert.strictEqual(oversized.statusCode, 413);
  assert.strictEqual(oversized.json().error, 'history_result_limit');
  assert.strictEqual(oversized.headers['cache-control'], 'no-store');
  // 错误响应必须 no-store：共享缓存把一次 400/416 钉在一个正常 URL 上，后面的请求就全废了。
  const badRange = await oversizedApp.inject({ method: 'GET', url: '/api/v1/history?from=nope&to=2026-08-22' });
  assert.strictEqual(badRange.statusCode, 400);
  assert.strictEqual(badRange.headers['cache-control'], 'no-store');
  await oversizedApp.close();
  const gapApp = await buildServer({ store: {
    getMeta: async () => ({ earliestDate: '2026-08-21', latestDate: '2026-08-23', availableDates: ['2026-08-21', '2026-08-23'] }),
    getHistory: async () => ({ from: '2026-08-21', to: '2026-08-23', players: [], messages: [], kills: [], dailyQuota: [], stats: [] })
  } });
  const gap = await gapApp.inject({ method: 'GET', url: '/api/v1/history?from=2026-08-21&to=2026-08-23' });
  assert.strictEqual(gap.statusCode, 416);
  assert.strictEqual(gap.headers['cache-control'], 'no-store');
  await gapApp.close();

  // 静态资源：assets/ 下带内容哈希的产物按不变对象缓存，index.html 必须每次回源，
  // 其余没有哈希的根文件取一个折中的 TTL。
  const distDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-dist-'));
  fs.mkdirSync(path.join(distDirectory, 'assets'));
  fs.writeFileSync(path.join(distDirectory, 'assets', 'index-B_SFExSR.js'), 'console.log(1);');
  fs.writeFileSync(path.join(distDirectory, 'assets', 'unhashed.svg'), '<svg/>');
  fs.writeFileSync(path.join(distDirectory, 'index.html'), '<!doctype html><title>panel</title>');
  fs.writeFileSync(path.join(distDirectory, 'favicon.svg'), '<svg/>');
  const distApp = await buildServer({ store, staticDirectory: distDirectory, requireStatic: true });
  const hashedAsset = await distApp.inject({ method: 'GET', url: '/assets/index-B_SFExSR.js' });
  assert.strictEqual(hashedAsset.statusCode, 200);
  assert.strictEqual(hashedAsset.headers['cache-control'], 'public, max-age=31536000, immutable');
  const indexHtml = await distApp.inject({ method: 'GET', url: '/index.html' });
  assert.strictEqual(indexHtml.headers['cache-control'], 'no-cache');
  const spaFallback = await distApp.inject({ method: 'GET', url: '/history/players' });
  assert.strictEqual(spaFallback.statusCode, 200);
  assert.strictEqual(spaFallback.headers['cache-control'], 'no-cache', 'SPA 回退发的也是 index.html');
  const favicon = await distApp.inject({ method: 'GET', url: '/favicon.svg' });
  assert.strictEqual(favicon.headers['cache-control'], 'public, max-age=3600');
  const unhashed = await distApp.inject({ method: 'GET', url: '/assets/unhashed.svg' });
  assert.strictEqual(unhashed.headers['cache-control'], 'public, max-age=3600', 'assets/ 下没有哈希的文件不能当不变对象');
  await distApp.close();
  fs.rmSync(distDirectory, { recursive: true, force: true });
  // 回归：合并实时端点的玩家查询是 LEFT JOIN player_state_current，没有当天状态行的玩家
  // state 是 null，筛选"体力没满"时不能直接点进去，否则整个端点 500。
  const nullStatePool = {
    query: async text => {
      if (text.includes('FROM snapshot_versions ORDER BY observed_at DESC')) return { rows: [{ snapshot_id: 'ns-s1', version_token: 'ns-v1', server_day: '2026-08-22', server_tick: 1, observed_at: '2026-08-22T00:00:00.000Z' }] };
      if (text.includes('LEFT JOIN player_quota_current')) return { rows: [{ user_id: 9, current_name: 'no-state', online: true, server_day: null, state: null }] };
      return { rows: [] };
    }
  };
  const nullStateApp = await buildServer({ store: new PostgresPanelStore({ pool: nullStatePool, engine: new ProjectionEngine({ minSteadyEntities: 1 }) }) });
  const nullStateRealtime = await nullStateApp.inject({ method: 'GET', url: '/api/v1/realtime' });
  assert.strictEqual(nullStateRealtime.statusCode, 200, '没有当天状态行的玩家不能让合并实时端点 500');
  assert.deepStrictEqual(nullStateRealtime.json().players, [], 'state 为 null 的玩家既没有 drop 也不算体力没满');
  await nullStateApp.close();

  // 历史分页：过滤和裁剪在路由层做，store 仍然返回整个区间。
  // 每 5 条里 1 条聊天、4 条击杀播报：这正是"仅看聊天"要解决的比例问题。
  // 每 3 条里 1 条击杀播报，且首尾都是击杀：留下的聊天行成对出现，每对的第一行带
  // folded_before=1，末尾还剩 1 条要作为 foldedAfter 落在最后一页上。
  const pageMessages = Array.from({ length: 250 }, (_, index) => ({ message_id: `m${index}`, kind: index % 3 === 0 ? 'kill' : 'chat', event_at: `2026-08-20T00:00:${String(index % 60).padStart(2, '0')}Z` }));
  const pageKills = Array.from({ length: 12 }, (_, index) => ({
    kill_id: `k${index}`,
    event_at: `2026-08-20T00:00:${String(index).padStart(2, '0')}Z`,
    killer_user_id: index % 3 === 0 ? 11 : 12,
    killer_name: index % 3 === 0 ? '甲' : '乙',
    victim_user_id: 20 + (index % 2),
    victim_name: index % 2 === 0 ? '丙' : '丁',
    drop: { amount: index === 5 ? null : index * 100 }
  }));
  const pageCalls = [];
  const pageApp = await buildServer({ store: {
    getMeta: async () => ({ earliestDate: '2026-08-20', latestDate: '2026-08-22', availableDates: ['2026-08-20', '2026-08-21', '2026-08-22'] }),
    getLatestVersion: async () => ({ version_token: 'page-v1', server_day: '2026-08-22' }),
    getHistoryChat: async (range, latest, rowCap) => { pageCalls.push({ resource: 'chat', rowCap }); return { from: range.from, to: range.to, closedThrough: range.to, messages: pageMessages }; },
    getHistoryKills: async (range, latest, rowCap) => { pageCalls.push({ resource: 'kills', rowCap }); return { from: range.from, to: range.to, closedThrough: range.to, kills: pageKills }; },
    getHistoryPlayers: async range => ({ from: range.from, to: range.to, closedThrough: range.to, players: [] })
  } });
  const chatBase = '/api/v1/history/chat?from=2026-08-20&to=2026-08-20';
  const noPage = await pageApp.inject({ method: 'GET', url: chatBase });
  assert.strictEqual(noPage.json().messages.length, 250, '不带分页参数必须保持原来的整区间行为');
  assert.strictEqual(noPage.json().pagination, undefined);
  assert.strictEqual(pageCalls.at(-1).rowCap, null, '整区间请求不能抬高 store 的行数上限');
  const firstPage = await pageApp.inject({ method: 'GET', url: `${chatBase}&pageSize=100` });
  assert.strictEqual(firstPage.json().messages.length, 100);
  assert.deepStrictEqual(firstPage.json().pagination, { page: 1, pageSize: 100, total: 250, totalPages: 3, hasPrev: false, hasNext: true });
  assert.deepStrictEqual(firstPage.json().messages[0], pageMessages[0]);
  assert.strictEqual(pageCalls.at(-1).rowCap, 200_000, '分页请求必须抬高 store 的行数上限');
  const lastPage = await pageApp.inject({ method: 'GET', url: `${chatBase}&pageSize=100&page=last` });
  assert.strictEqual(lastPage.json().pagination.page, 3);
  assert.strictEqual(lastPage.json().messages.length, 50);
  const clamped = await pageApp.inject({ method: 'GET', url: `${chatBase}&pageSize=100&page=99` });
  assert.strictEqual(clamped.json().pagination.page, 3, '越界页号夹到最后一页而不是报错');
  const pageTwo = await pageApp.inject({ method: 'GET', url: `${chatBase}&pageSize=100&page=2` });
  assert.notStrictEqual(pageTwo.headers.etag, firstPage.headers.etag, '不同页必须有不同的 ETag');
  assert.strictEqual(pageTwo.headers['x-panel-cache'], 'miss');
  assert.strictEqual((await pageApp.inject({ method: 'GET', url: `${chatBase}&pageSize=100&page=2` })).headers['x-panel-cache'], 'hit');
  const onlyChat = await pageApp.inject({ method: 'GET', url: `${chatBase}&pageSize=100&onlyChat=1` });
  assert.deepStrictEqual(onlyChat.json().pagination, { page: 1, pageSize: 100, total: 166, totalPages: 2, hasPrev: false, hasNext: true }, '仅看聊天必须按过滤后的条数分页');
  assert.ok(onlyChat.json().messages.every(message => message.kind === 'chat'), '仅看聊天只排除击杀播报');
  assert.strictEqual(onlyChat.json().messages[0].folded_before, 1, '被折掉的击杀条数要挂在紧接其后的消息上');
  assert.strictEqual(onlyChat.json().messages[1].folded_before, undefined, '前面没折东西的消息不带这个字段');
  assert.strictEqual(onlyChat.json().foldedAfter, undefined, '尾部折叠只属于最后一页');
  assert.notStrictEqual(onlyChat.headers.etag, firstPage.headers.etag, '过滤条件进缓存键');
  const onlyChatLast = await pageApp.inject({ method: 'GET', url: `${chatBase}&pageSize=100&onlyChat=1&page=last` });
  assert.strictEqual(onlyChatLast.json().messages.length, 66);
  assert.strictEqual(onlyChatLast.json().foldedAfter, 1, '最后一页要带上末尾还剩的折叠条数');
  const onlyChatOff = await pageApp.inject({ method: 'GET', url: `${chatBase}&pageSize=100&onlyChat=0` });
  assert.strictEqual(onlyChatOff.json().pagination.total, 250, 'onlyChat=0 等于不过滤');
  assert.ok(onlyChatOff.json().messages.every(message => message.folded_before === undefined), '不折叠时不能改动原始行');
  assert.strictEqual(onlyChatOff.json().foldedAfter, undefined);
  for (const bad of ['pageSize=250', 'pageSize=100&page=0', 'pageSize=100&page=x', 'page=2', 'minDrop=1', 'onlyChat=yes']) {
    const response = await pageApp.inject({ method: 'GET', url: `${chatBase}&${bad}` });
    assert.strictEqual(response.statusCode, 400, `${bad} 必须被拒绝`);
    assert.strictEqual(response.json().error, 'invalid_pagination');
    assert.strictEqual(response.headers['cache-control'], 'no-store');
  }
  const killsBase = '/api/v1/history/kills?from=2026-08-20&to=2026-08-20';
  const dropFiltered = await pageApp.inject({ method: 'GET', url: `${killsBase}&pageSize=100&minDrop=500` });
  assert.deepStrictEqual(dropFiltered.json().kills.map(kill => kill.kill_id), ['k6', 'k7', 'k8', 'k9', 'k10', 'k11'], '金额未知的击杀在有阈值时必须排除');
  assert.strictEqual(dropFiltered.json().pagination.total, 6);
  // 候选表按拼音排序：丙(20) < 丁(21) < 甲(11) < 乙(12)。
  assert.deepStrictEqual(dropFiltered.json().filterOptions.players.map(player => player.userId), [20, 21, 11, 12]);
  const userFiltered = await pageApp.inject({ method: 'GET', url: `${killsBase}&pageSize=100&minDrop=500&users=11` });
  assert.deepStrictEqual(userFiltered.json().kills.map(kill => kill.kill_id), ['k6', 'k9'], 'users 同时匹配击杀者和被击杀者');
  assert.strictEqual(userFiltered.json().pagination.total, 2);
  assert.deepStrictEqual(userFiltered.json().filterOptions.players.map(player => player.userId), [20, 21, 11, 12], '候选表按阈值算，不受已勾选的人影响');
  const orphanSelection = await pageApp.inject({ method: 'GET', url: `${killsBase}&pageSize=100&minDrop=100000&users=12` });
  assert.strictEqual(orphanSelection.json().pagination.total, 0);
  assert.deepStrictEqual(orphanSelection.json().filterOptions.players, [{ userId: 12, name: '乙' }], '已勾选的人即使在新阈值下没有击杀也要留在候选表里');
  const filterOnly = await pageApp.inject({ method: 'GET', url: `${killsBase}&minDrop=500` });
  assert.strictEqual(filterOnly.json().kills.length, 6, '只给过滤条件不给页大小时仍然返回全部命中行');
  assert.strictEqual(filterOnly.json().pagination, undefined);
  const killsOnlyChat = await pageApp.inject({ method: 'GET', url: `${killsBase}&pageSize=100&onlyChat=1` });
  assert.strictEqual(killsOnlyChat.statusCode, 400, 'onlyChat 只对聊天有意义');
  const orderedUsers = await pageApp.inject({ method: 'GET', url: `${killsBase}&pageSize=100&users=12,11` });
  assert.strictEqual(orderedUsers.headers.etag, (await pageApp.inject({ method: 'GET', url: `${killsBase}&pageSize=100&users=11,12` })).headers.etag, 'users 顺序不同不能各占一条缓存');
  for (const bad of ['pageSize=100', 'minDrop=1', 'users=1', 'onlyChat=1'].map(query => `/api/v1/history/players?from=2026-08-20&to=2026-08-20&${query}`).concat(['/api/v1/history?from=2026-08-20&to=2026-08-20&pageSize=100', '/api/v1/history?from=2026-08-20&to=2026-08-20&onlyChat=1'])) {
    const response = await pageApp.inject({ method: 'GET', url: bad });
    assert.strictEqual(response.statusCode, 400, `${bad} 必须被拒绝`);
    assert.strictEqual(response.json().error, 'invalid_pagination');
  }
  const negativeDrop = await pageApp.inject({ method: 'GET', url: `${killsBase}&minDrop=-1` });
  assert.strictEqual(negativeDrop.statusCode, 400);
  const tooManyUsers = await pageApp.inject({ method: 'GET', url: `${killsBase}&users=${Array.from({ length: 65 }, (_, index) => index + 1).join(',')}` });
  assert.strictEqual(tooManyUsers.statusCode, 400);
  await pageApp.close();

  console.log('api tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
