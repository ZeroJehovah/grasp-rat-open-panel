'use strict';

const assert = require('assert');
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
      if (text.includes('FROM snapshot_versions WHERE completeness')) return { rows: [{ snapshot_id: 'pg-s1', version_token: 'pg-v1', server_day: '2026-08-22', server_tick: 1, observed_at: '2026-08-22T00:00:00.000Z' }] };
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
  assert.ok(postgresCalls.some(call => call.text.includes('ranged_quota') && call.values?.[0] === '2026-08-22' && call.values?.[1] === '2026-08-22'));
  const staticApp = await buildServer({ store, staticDirectory: path.resolve(__dirname, '../frontend'), requireStatic: true });
  const staticAsset = await staticApp.inject({ method: 'GET', url: '/src/App.tsx' });
  assert.strictEqual(staticAsset.statusCode, 200);
  assert.match(staticAsset.body, /export default function App/);
  await staticApp.close();
  const compressedApp = await buildServer({ store: {
    getMeta: async () => ({ earliestDate: '2026-08-22', latestDate: '2026-08-22' }),
    getHistory: async () => ({ from: '2026-08-22', to: '2026-08-22', timezone: 'Asia/Shanghai', closedThrough: null, players: Array.from({ length: 100 }, (_, index) => ({ userId: index, name: 'compression-fixture-' + 'x'.repeat(32) })), messages: [], kills: [], dailyQuota: [], stats: [] })
  } });
  const compressedHistory = await compressedApp.inject({ method: 'GET', url: '/api/v1/history?from=2026-08-22&to=2026-08-22', headers: { 'accept-encoding': 'gzip' } });
  assert.strictEqual(compressedHistory.headers['content-encoding'], 'gzip');
  assert.strictEqual(JSON.parse(zlib.gunzipSync(compressedHistory.rawPayload).toString('utf8')).from, '2026-08-22');
  await compressedApp.close();
  const cachedHistory = await app.inject({ method: 'GET', url: '/api/v1/history?from=2026-08-22&to=2026-08-22', headers: { 'if-none-match': history.headers.etag } });
  assert.strictEqual(cachedHistory.statusCode, 304);
  await app.close();

  const oversizedApp = await buildServer({ store: {
    getMeta: async () => ({ earliestDate: '2026-08-22', latestDate: '2026-08-22' }),
    getHistory: async () => ({ from: '2026-08-22', to: '2026-08-22', timezone: 'Asia/Shanghai', closedThrough: null, players: Array.from({ length: 5_001 }, () => ({})), messages: [], kills: [], dailyQuota: [], stats: [] })
  } });
  const oversized = await oversizedApp.inject({ method: 'GET', url: '/api/v1/history?from=2026-08-22&to=2026-08-22' });
  assert.strictEqual(oversized.statusCode, 413);
  assert.strictEqual(oversized.json().error, 'history_result_limit');
  await oversizedApp.close();
  const gapApp = await buildServer({ store: {
    getMeta: async () => ({ earliestDate: '2026-08-21', latestDate: '2026-08-23', availableDates: ['2026-08-21', '2026-08-23'] }),
    getHistory: async () => ({ from: '2026-08-21', to: '2026-08-23', players: [], messages: [], kills: [], dailyQuota: [], stats: [] })
  } });
  const gap = await gapApp.inject({ method: 'GET', url: '/api/v1/history?from=2026-08-21&to=2026-08-23' });
  assert.strictEqual(gap.statusCode, 416);
  await gapApp.close();
  console.log('api tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
