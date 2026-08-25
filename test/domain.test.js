'use strict';

const assert = require('assert');
const { addDays, isDateRangeCovered, parseSnapshot, presetRangesForDates } = require('../domain/snapshot');
const { ProjectionEngine } = require('../domain/projector');

assert.strictEqual(addDays('2024-02-28', 1), '2024-02-29');
assert.strictEqual(isDateRangeCovered({ from: '2026-08-21', to: '2026-08-23' }, ['2026-08-21', '2026-08-22', '2026-08-23']), true);
assert.strictEqual(isDateRangeCovered({ from: '2026-08-21', to: '2026-08-23' }, ['2026-08-21', '2026-08-23']), false);
assert.deepStrictEqual(presetRangesForDates('2026-08-23', [
  '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'
]), {
  today: { from: '2026-08-23', to: '2026-08-23' },
  yesterday: { from: '2026-08-22', to: '2026-08-22' },
  'this-week': { from: '2026-08-17', to: '2026-08-23' },
  'last-week': null,
  'this-month': null,
  'last-month': null
});

function entity(overrides = {}) {
  return {
    entity_id: 11,
    user_id: 7,
    name: 'tester',
    x: 10,
    y: -20,
    vx: 0,
    vy: 0,
    cell: [0, 0],
    hp: 100,
    max_hp: 100,
    invulnerable_until_tick: 0,
    invulnerable_remaining_ticks: 0,
    invulnerable_remaining_secs: 0,
    stamina_5s_remaining_milli: 10000,
    stamina_1h_remaining_milli: 3000000,
    stamina_1d_remaining_milli: 20000000,
    stamina_5s_limit_milli: 10000,
    stamina_1h_limit_milli: 3000000,
    stamina_1d_limit_milli: 20000000,
    coins: 1000,
    death_drop_coins: 5,
    death_reward_preview: 1,
    death_loss_preview: 2,
    death_total_loss_preview: 3,
    daily_budget_day_key_utc8: 20687,
    external_balance_snapshot: 50000000,
    coin_value_snapshot: 1,
    reward_pool_limit: 10,
    reward_dropped_today: 0,
    reward_remaining_today: 10,
    death_loss_pool_limit: 10,
    death_lost_today: 0,
    death_loss_remaining_today: 10,
    active_join_count: 0,
    passive_join_count: 1,
    death_count: 0,
    waiting_revive_count: 0,
    waiting_revive: false,
    revive_at_tick: 0,
    active_join_ticks: [],
    passive_join_ticks: [1],
    death_ticks: [],
    visible: 'Visible',
    joined: 'InGame',
    current_join_mode: 'Passive',
    life: 'Alive',
    ...overrides
  };
}

function body(tick, overrides = {}, top = {}) {
  const entities = overrides.entities || [entity(overrides.entity || {})];
  return Buffer.from(JSON.stringify({
    type: 'snapshot', tick, total_entities: entities.length, in_game: entities.length, visible: entities.length,
    occupied_cells: entities.length, entities, bullets: [], coin_drops: [], messages: [], ...top
  }));
}

function observation(engine, value, time) {
  return engine.applyObservation(value, { observationId: `test-${time}`, observedAt: `2026-08-22T${time}+08:00`, statusCode: 200 });
}

(() => {
  const parsed = parseSnapshot(body(100), { observedAt: '2026-08-22T00:01:00+08:00', minSteadyEntities: 1 });
  assert.strictEqual(parsed.completeness, 'steady');
  assert.strictEqual(parsed.serverDay, '2026-08-22');
  assert.strictEqual(parsed.entities[0].user_id, 7);
  const warming = parseSnapshot(body(1, { entities: [] }), { observedAt: '2026-08-22T00:00:00+08:00', minSteadyEntities: 1 });
  assert.strictEqual(warming.completeness, 'warming_up');
  const invalid = parseSnapshot(Buffer.from('{bad'), { observedAt: '2026-08-22T00:00:00+08:00' });
  assert.strictEqual(invalid.completeness, 'invalid');
})();

// 回归：世界重启后实体集要好几分钟才长回来。实时读必须跟着正在恢复的世界走，不能
// 钉在前一天最后一个稳定版本上；同时在线区间和 base/delta 链只能由稳定快照驱动。
(() => {
  const engine = new ProjectionEngine({ minSteadyEntities: 2 });
  const a = entity({ user_id: 7, entity_id: 11, name: 'a' });
  const b = entity({ user_id: 8, entity_id: 12, name: 'b' });
  const steady = observation(engine, body(5000, { entities: [a, b] }), '00:01:00');
  assert.strictEqual(steady.status, 'projected');
  const bases = engine.stateBases.length;
  const deltas = engine.stateDeltas.length;
  const intervals = engine.onlineIntervals.length;

  // tick 倒退：服务端重启了，世界正在重新填充。
  const nextA = entity({ user_id: 7, entity_id: 21, name: 'a', daily_budget_day_key_utc8: 20688 });
  const warming = observation(engine, body(11, { entities: [nextA] }), '00:02:00');
  assert.strictEqual(warming.status, 'warming_up');
  assert.strictEqual(warming.version.reset_generation, 1, '倒退的 tick 必须算作新一代');
  assert.strictEqual(warming.version.server_day, '2026-08-23');

  // 实时读跟随最新版本，而不是前一天最后一个稳定版本。
  assert.strictEqual(engine.getLatestVersion().snapshot_id, warming.version.snapshot_id);
  assert.strictEqual(engine.getLatestVersion().completeness, 'warming_up');
  assert.strictEqual(engine.getLatestStableVersion().snapshot_id, steady.version.snapshot_id);
  assert.strictEqual(engine.getRealtimeChat().serverDay, '2026-08-23', '实时聊天必须查当天，不能回落到前一天');
  assert.strictEqual(engine.currentStates.get('7').server_day, '2026-08-23');
  assert.strictEqual(engine.currentStates.get('7').entity_id, 21, '预热快照必须推进展示状态');
  assert.strictEqual(engine.players.get('7').online, true);
  assert.ok(engine.getAvailableDates().includes('2026-08-23'), '只有预热版本的当天也要出现在可选日期里');

  // 不完整的实体集不能碰计时和历史重建。
  assert.strictEqual(engine.onlineIntervals.length, intervals, '预热快照不能新开在线区间');
  assert.ok(engine.onlineIntervals.every(interval => interval.online_to_at === null), '预热快照不能关闭上一日的在线区间');
  assert.strictEqual(engine.stateBases.length, bases, '预热快照不能写 base');
  assert.strictEqual(engine.stateDeltas.length, deltas, '预热快照不能写 delta');
  assert.strictEqual(engine.verifyRebuild().ok, true);

  // 预热后的首个稳定快照要用整条 base 重新锚定历史，而不是去 diff 一个从未落库的状态。
  const nextB = entity({ user_id: 8, entity_id: 22, name: 'b', daily_budget_day_key_utc8: 20688 });
  const recovered = observation(engine, body(12000, { entities: [nextA, nextB] }), '00:12:00');
  assert.strictEqual(recovered.status, 'projected');
  assert.strictEqual(engine.stateBases.length, bases + 2, '预热后的首个稳定快照要给两个玩家各写一条新 base');
  assert.strictEqual(engine.stateDeltas.length, deltas, '跨代恢复不能产生 delta');
  assert.strictEqual(engine.verifyRebuild().ok, true);
})();

(() => {
  const engine = new ProjectionEngine({ minSteadyEntities: 1 });
  const first = observation(engine, body(100), '00:01:00');
  const second = observation(engine, body(200, { entity: { death_drop_coins: 6 } }), '00:02:00');
  const duplicate = observation(engine, body(200, { entity: { death_drop_coins: 6 } }), '00:02:30');
  const third = observation(engine, body(300, { entity: { death_drop_coins: 4 } }), '00:03:00');
  assert.strictEqual(first.status, 'projected');
  assert.strictEqual(second.status, 'projected');
  assert.strictEqual(duplicate.status, 'duplicate');
  assert.strictEqual(third.status, 'projected');
  assert.strictEqual(engine.versions.length, 3);
  assert.strictEqual(engine.stateBases.length, 1);
  assert.strictEqual(engine.stateDeltas.length, 2);
  assert.strictEqual(engine.quotaCurrent.get('7').initial_quota, 100);
  assert.strictEqual(engine.quotaCurrent.get('7').quota_value, 100);
  const realtimePlayer = engine.getRealtimePlayers().players[0];
  assert.strictEqual(realtimePlayer.state.invulnerableRemainingSecs, 0);
  assert.strictEqual(realtimePlayer.state.loss, 2);
  assert.strictEqual(realtimePlayer.externalBalanceSnapshot, 50000000);
  assert.strictEqual(engine.onlineIntervals[0].online_to_snapshot_id, null);
  assert.strictEqual(engine.messages.size, 0);
  assert.strictEqual(engine.verifyRebuild().ok, true);
})();

(() => {
  const engine = new ProjectionEngine({ minSteadyEntities: 1 });
  const online = entity({ user_id: 7, name: 'online-today', death_drop_coins: 2, x: 10, y: 20 });
  const offline = entity({ user_id: 8, entity_id: 12, name: 'offline-today', death_drop_coins: 15, x: 30, y: 40 });
  observation(engine, body(100, { entities: [online, offline] }), '01:00:00');
  observation(engine, body(200, { entities: [online] }), '01:01:00');
  const realtime = engine.getRealtimePlayers();
  const offlineView = realtime.players.find(player => player.userId === 8);
  assert.strictEqual(offlineView.online, false);
  assert.strictEqual(offlineView.drop, 15);
  assert.strictEqual(offlineView.state.hp, 100);
  assert.deepStrictEqual({ x: offlineView.state.x, y: offlineView.state.y }, { x: 30, y: 40 });

  const nextDay = entity({ user_id: 7, name: 'online-next-day', daily_budget_day_key_utc8: 20688 });
  observation(engine, body(10, { entities: [nextDay] }), '01:02:00');
  const nextRealtime = engine.getRealtimePlayers();
  const noLoginToday = nextRealtime.players.find(player => player.userId === 8);
  assert.strictEqual(noLoginToday.online, false);
  assert.strictEqual(noLoginToday.drop, null);
  assert.strictEqual(noLoginToday.state, null);
})();

(() => {
  const engine = new ProjectionEngine({ minSteadyEntities: 1 });
  observation(engine, body(100, { entity: { death_drop_coins: 5, external_balance_snapshot: 1000000 } }), '00:20:00');
  observation(engine, body(200, { entity: { death_drop_coins: 4, external_balance_snapshot: 1000000 } }), '00:21:00');
  const quota = engine.quotaCurrent.get('7');
  assert.strictEqual(quota.initial_quota, 2);
  assert.strictEqual(quota.quota_value, 2);
  assert.strictEqual(engine.dailyQuota.get('2026-08-22:7').income, 0);
})();

(() => {
  const engine = new ProjectionEngine({ minSteadyEntities: 1 });
  observation(engine, body(600, { entity: { extra_first: 1, extra_second: 2 } }), '00:24:00');
  observation(engine, body(700, { entity: { extra_second: 2, extra_first: 1 } }), '00:25:00');
  assert.strictEqual(engine.stateDeltas.length, 0);
  assert.strictEqual(engine.verifyRebuild().ok, true);
})();

(() => {
  const engine = new ProjectionEngine({ minSteadyEntities: 1 });
  observation(engine, body(500, { entity: { death_drop_coins: 5, external_balance_snapshot: 30000000 } }), '00:22:00');
  const nextDay = observation(engine, body(10, { entity: { death_drop_coins: 3, external_balance_snapshot: 20000000, daily_budget_day_key_utc8: 20688 } }), '00:23:00');
  assert.strictEqual(nextDay.parsed.serverDay, '2026-08-23');
  assert.strictEqual(engine.quotaCurrent.get('7').initial_quota, 40);
  assert.strictEqual(engine.quotaCurrent.get('7').quota_value, 40);
  assert.strictEqual(engine.dailyQuota.get('2026-08-22:7').income, 0);
  engine.finalizeDay('2026-08-22', '2026-08-23T00:10:00.000Z');
  assert.ok(engine.dailyQuota.get('2026-08-22:7').finalized_at);
})();

(() => {
  const engine = new ProjectionEngine({ minSteadyEntities: 1 });
  observation(engine, body(500), '00:05:00');
  const warming = observation(engine, body(1, { entities: [] }), '00:05:30');
  assert.strictEqual(warming.status, 'warming_up');
  assert.strictEqual(engine.onlineIntervals[0].online_to_snapshot_id, null);
  const next = observation(engine, body(2, { entity: { daily_budget_day_key_utc8: 20688 } }), '00:06:00');
  assert.strictEqual(next.parsed.resetGeneration, 1);
  assert.strictEqual(engine.stateBases.length, 2);
  assert.notStrictEqual(engine.onlineIntervals[0].online_to_snapshot_id, null);
})();

(() => {
  const engine = new ProjectionEngine({ minSteadyEntities: 1 });
  const victim = entity({ user_id: 7, entity_id: 11, name: 'victim', x: 40, y: 50 });
  const killer = entity({ user_id: 8, entity_id: 12, name: 'killer', x: -10, y: -20 });
  observation(engine, body(100, { entities: [victim, killer] }), '00:10:00');
  observation(engine, body(200, { entities: [victim, killer] }, { messages: [{ id: 9001, tick: 150, kind: 'kill', user_id: 8, target_user_id: 7, text: 'killer killed victim' }] }), '00:10:30');
  const kill = engine.kills.get('9001');
  assert.strictEqual(kill.drop.amount, 5);
  assert.deepStrictEqual(kill.victim_position, { x: 40, y: 50 });
  assert.strictEqual(kill.victim_stamina_5s, 10000);
})();

(() => {
  const engine = new ProjectionEngine({ minSteadyEntities: 2 });
  const victim = entity({ user_id: 7, entity_id: 11, name: 'victim', x: 40, y: 50 });
  const killer = entity({ user_id: 8, entity_id: 12, name: 'killer', x: -10, y: -20 });
  const message = { id: 9002, tick: 150, kind: 'kill', user_id: 8, target_user_id: 7, text: 'killer killed victim' };
  observation(engine, body(100, { entities: [] }, { messages: [message] }), '00:11:00');
  observation(engine, body(200, { entities: [victim, killer] }, { messages: [message] }), '00:11:30');
  observation(engine, body(300, { entities: [victim, killer] }, { messages: [message] }), '00:12:00');
  const kill = engine.kills.get('9002');
  assert.strictEqual(kill.evidence_snapshot_id, engine.versions[1].snapshot_id);
  assert.deepStrictEqual(kill.victim_position, { x: 40, y: 50 });
})();

(() => {
  const engine = new ProjectionEngine({ minSteadyEntities: 1 });
  const drop = { drop_id: 77, source_user_id: 7, system_spawned: false, x: 1, y: 2, amount: 5, created_tick: 100 };
  const message = { id: 9010, tick: 100, kind: 'chat', user_id: 7, target_user_id: null, text: 'hello' };
  observation(engine, body(100, {}, { coin_drops: [drop], messages: [message] }), '00:13:00');
  observation(engine, body(200, {}, { coin_drops: [drop], messages: [message] }), '00:13:30');
  assert.strictEqual(engine.messages.get('9010').last_observed_snapshot_id, engine.versions[1].snapshot_id);
  observation(engine, body(300, {}, { coin_drops: [], messages: [] }), '00:14:00');
  assert.strictEqual(engine.drops.get('2026-08-22:77').disappeared_at, '2026-08-21T16:14:00.000Z');
  assert.strictEqual(engine.lastTouchedDrops[0].drop_id, 77);
})();

(() => {
  const engine = new ProjectionEngine({ minSteadyEntities: 1 });
  engine.lastStableVersion = { server_day: '2026-08-23' };
  for (let userId = 1; userId <= 150; userId += 1) {
    const quotaValue = userId <= 50 ? 2_000 - userId : 0;
    const drop = userId > 50 && userId <= 100 ? 2_000 - userId : 0;
    const income = userId > 100 ? 2_000 - userId : 0;
    engine.players.set(String(userId), { user_id: userId, current_name: `player-${String(userId).padStart(3, '0')}`, last_seen_at: '2026-08-23T00:00:00.000Z', current_entity_id: userId, online: true });
    engine.currentStates.set(String(userId), { user_id: userId, server_day: '2026-08-23', online: true, death_drop_coins: drop, hp: 100, x: 0, y: 0, entity_id: userId, snapshot_id: 'scale', observed_at: '2026-08-23T00:00:00.000Z' });
    engine.dailyQuota.set(`2026-08-23:${userId}`, { user_id: userId, local_date: '2026-08-23', initial_quota: quotaValue - income, closing_quota: quotaValue, income, finalized_at: null });
  }
  const history = engine.getHistory({ from: '2026-08-23', to: '2026-08-23' });
  assert.strictEqual(history.players.length, 150);
  assert.ok(history.players.some(player => player.userId === 1));
  assert.ok(history.players.some(player => player.userId === 51));
  assert.ok(history.players.some(player => player.userId === 101));
})();

(() => {
  // The first frames of a new day can report external_balance_snapshot = 0
  // before the game refills the per-day fields; they must not become the daily
  // baseline, or the restored balance reads as a full day of income.
  const engine = new ProjectionEngine({ minSteadyEntities: 1 });
  observation(engine, body(100, { entity: { external_balance_snapshot: 50000000 } }), '00:30:00');
  observation(engine, body(200, { entity: { external_balance_snapshot: 0, death_drop_coins: 0, daily_budget_day_key_utc8: 20688 } }), '00:30:15');
  observation(engine, body(300, { entity: { external_balance_snapshot: 0, death_drop_coins: 0, daily_budget_day_key_utc8: 20688 } }), '00:30:30');
  assert.strictEqual(engine.dailyQuota.get('2026-08-23:7'), undefined);
  assert.strictEqual(engine.quotaCurrent.get('7').quota_day, '2026-08-22');
  observation(engine, body(400, { entity: { external_balance_snapshot: 50000000, daily_budget_day_key_utc8: 20688 } }), '00:40:00');
  assert.strictEqual(engine.quotaCurrent.get('7').quota_day, '2026-08-23');
  assert.strictEqual(engine.quotaCurrent.get('7').initial_quota, 100);
  assert.strictEqual(engine.dailyQuota.get('2026-08-23:7').initial_quota, 100);
  assert.strictEqual(engine.dailyQuota.get('2026-08-23:7').income, 0);
  // Once the day has a baseline a real drop to zero is recorded straight away.
  observation(engine, body(500, { entity: { external_balance_snapshot: 0, daily_budget_day_key_utc8: 20688 } }), '00:41:00');
  assert.strictEqual(engine.dailyQuota.get('2026-08-23:7').income, -100);
})();

(() => {
  // A player who really starts a day at zero must still be recorded, so the
  // hold above expires instead of masking the balance for the whole day.
  const engine = new ProjectionEngine({ minSteadyEntities: 1 });
  observation(engine, body(100, { entity: { external_balance_snapshot: 50000000 } }), '00:50:00');
  observation(engine, body(200, { entity: { external_balance_snapshot: 0, daily_budget_day_key_utc8: 20688 } }), '00:50:15');
  assert.strictEqual(engine.quotaCurrent.get('7').quota_day, '2026-08-22');
  observation(engine, body(300, { entity: { external_balance_snapshot: 0, daily_budget_day_key_utc8: 20688 } }), '01:25:00');
  assert.strictEqual(engine.quotaCurrent.get('7').quota_day, '2026-08-23');
  assert.strictEqual(engine.quotaCurrent.get('7').quota_value, 0);
  assert.strictEqual(engine.dailyQuota.get('2026-08-23:7').initial_quota, 0);
  assert.strictEqual(engine.dailyQuota.get('2026-08-23:7').income, 0);
})();

console.log('domain tests passed');
