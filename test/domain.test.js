'use strict';

const assert = require('assert');
const { parseSnapshot } = require('../domain/snapshot');
const { ProjectionEngine } = require('../domain/projector');

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
    external_balance_snapshot: 100,
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
  assert.strictEqual(engine.quotaCurrent.get('7').quota_value, 94);
  assert.strictEqual(engine.onlineIntervals[0].online_to_snapshot_id, null);
  assert.strictEqual(engine.messages.size, 0);
  assert.strictEqual(engine.verifyRebuild().ok, true);
})();

(() => {
  const engine = new ProjectionEngine({ minSteadyEntities: 1 });
  observation(engine, body(100, { entity: { death_drop_coins: 5, death_loss_preview: null } }), '00:20:00');
  observation(engine, body(200, { entity: { death_drop_coins: 4, death_loss_preview: null } }), '00:21:00');
  const quota = engine.quotaCurrent.get('7');
  const adjustment = engine.quotaAdjustments.at(-1);
  assert.strictEqual(quota.initial_quota, 100);
  assert.strictEqual(quota.quota_value, null);
  assert.strictEqual(adjustment.reason, 'drop_decrease');
  assert.strictEqual(adjustment.loss_before, null);
  assert.strictEqual(adjustment.adjustment, null);
  assert.strictEqual(adjustment.computable, false);
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
  observation(engine, body(500, { entity: { death_drop_coins: 5 } }), '00:22:00');
  const nextDay = observation(engine, body(10, { entity: { death_drop_coins: 3, daily_budget_day_key_utc8: 20688 } }), '00:23:00');
  assert.strictEqual(nextDay.parsed.serverDay, '2026-08-23');
  assert.strictEqual(engine.quotaCurrent.get('7').initial_quota, 60);
  assert.strictEqual(engine.quotaCurrent.get('7').quota_value, 60);
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

console.log('domain tests passed');
