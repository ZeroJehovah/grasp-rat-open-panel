'use strict';

const assert = require('node:assert/strict');
const { CompactPostgresPanelStore } = require('../storage/compact-postgres-store');

const LATEST = {
  snapshot_id: 'snap-1', version_token: 'v1', server_day: '2026-08-22', reset_generation: 0,
  server_tick: 10, observed_at: '2026-08-22T00:00:00.000Z', entity_count: 12, completeness: 'steady'
};

function fakePool(rowsForPlayers) {
  const calls = [];
  return {
    calls,
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes('panel_version_dedupe')) return { rows: [LATEST] };
      if (text.includes('panel_player_current')) return { rows: rowsForPlayers };
      return { rows: [] };
    }
  };
}

function playerRow(overrides = {}) {
  return {
    user_id: 7, current_name: 'widget', last_seen_at: null, current_entity_id: null, online: true,
    server_day: '2026-08-22', snapshot_id: 'snap-1', observed_at: null, reset_generation: 0,
    state: {}, quota_day: null, initial_quota: null, quota_value: null, income: null,
    kills: '3', deaths: '1',
    ...overrides
  };
}

async function realtimePlayers(pool) {
  const store = new CompactPostgresPanelStore({ pool, engine: undefined });
  const payload = await store.getRealtimePlayers(null);
  return { payload, playersSql: pool.calls.filter(call => call.text.includes('panel_player_current')).map(call => call.text).join('\n') };
}

async function main() {
  const pool = fakePool([playerRow()]);
  const { payload, playersSql } = await realtimePlayers(pool);

  // 玩家候选集合按 user_id 先选出，再回表取这些行的完整状态；今天的击杀/死亡只在
  // panel_kill_events 上聚合一次。历史里曾经对 panel_player_current 每一行都跑两个
  // correlated subquery（32k 行实测 6–17 秒），这个断言就是防它回潮。
  assert.ok(!/killer_user_id\s*=\s*(?:pc|r)\.user_id/.test(playersSql), 'realtime players must not count kills per player row');
  assert.ok(!/victim_user_id\s*=\s*(?:pc|r)\.user_id/.test(playersSql), 'realtime players must not count deaths per player row');
  assert.ok(playersSql.includes('FROM panel_kill_events WHERE local_date=$1::date'), 'today\'s kills are aggregated once with the business day filter');
  assert.ok(/GROUP BY user_id/.test(playersSql), 'the kill aggregate groups by user');
  assert.ok(/FROM panel_player_current r INNER JOIN candidates c USING \(user_id\)/.test(playersSql), 'only candidate players are read back from the wide table');
  assert.deepStrictEqual(payload.players.length, 1);
  assert.deepStrictEqual(payload.players[0].userId, 7);
  assert.deepStrictEqual(payload.players[0].kills, 3);
  assert.deepStrictEqual(payload.players[0].deaths, 1);
  assert.deepStrictEqual(payload.versionToken, 'v1');

  // 版本没变时仍然走 unchanged 快路径，不再查面板行。
  const unchangedPool = fakePool([playerRow()]);
  const store = new CompactPostgresPanelStore({ pool: unchangedPool, engine: undefined });
  const unchanged = await store.getRealtimePlayers('v1');
  assert.deepStrictEqual(unchanged.unchanged, true);
  assert.strictEqual(unchangedPool.calls.filter(call => call.text.includes('panel_kill_events')).length, 0);

  console.log('compact store tests passed');
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
