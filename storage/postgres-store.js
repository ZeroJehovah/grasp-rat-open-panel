'use strict';

const { Pool } = require('pg');
const { ProjectionEngine, loadMapMetadata } = require('../domain/projector');
const { BUSINESS_TIMEZONE, SCHEMA_VERSION, cloneJson } = require('../domain/snapshot');

const HISTORY_ROW_LIMITS = Object.freeze({
  players: 5_000,
  messages: 10_000,
  kills: 10_000,
  dailyQuota: 100_000,
  stats: 100_000
});

function mapKey(...parts) {
  return parts.map(part => String(part ?? '')).join(':');
}

function toDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function historyQuotaRow(row) {
  return {
    local_date: String(row.local_date).slice(0, 10),
    user_id: Number(row.user_id),
    initial_quota: numberOrNull(row.initial_quota),
    closing_quota: numberOrNull(row.closing_quota),
    income: numberOrNull(row.income),
    finalized_at: row.finalized_at ? toDate(row.finalized_at) : null
  };
}

function historyStatRow(row) {
  return {
    local_date: String(row.local_date).slice(0, 10),
    user_id: Number(row.user_id),
    kills: Number(row.kills || 0),
    deaths: Number(row.deaths || 0)
  };
}

function historyLimitError(resource, limit) {
  const error = new Error(`history ${resource} result exceeds ${limit} rows`);
  error.code = 'history_result_limit';
  error.resource = resource;
  error.limit = limit;
  return error;
}

function limitedRows(result, resource, limit) {
  if (result.rows.length > limit) throw historyLimitError(resource, limit);
  return result.rows;
}

function rowToPlayer(row, stats = { kills: 0, deaths: 0 }, options = {}) {
  const state = row.state || {};
  const rowDay = row.server_day ? String(row.server_day).slice(0, 10) : null;
  const currentDay = options.currentDay ? String(options.currentDay).slice(0, 10) : null;
  const isCurrentDay = !currentDay || rowDay === currentDay;
  const quotaValue = row.quota_value === null || row.quota_value === undefined ? null : Number(row.quota_value);
  const initialQuota = row.initial_quota === null || row.initial_quota === undefined ? null : Number(row.initial_quota);
  const currentDrop = state.death_drop_coins === undefined ? null : numberOrNull(state.death_drop_coins);
  const todayIncome = row.today_income === undefined
    ? (row.income === null || row.income === undefined ? null : Number(row.income))
    : numberOrNull(row.today_income);
  return {
    userId: Number(row.user_id),
    name: row.current_name || '',
    online: Boolean(row.online && isCurrentDay),
    lastSeenAt: toDate(row.last_seen_at),
    currentEntityId: row.current_entity_id === null ? null : Number(row.current_entity_id),
    drop: isCurrentDay ? currentDrop : null,
    quota: row.quota_day ? {
      day: row.quota_day,
      initial: initialQuota,
      value: quotaValue,
      income: initialQuota !== null && quotaValue !== null ? quotaValue - initialQuota : null
    } : null,
    income: row.income === null || row.income === undefined ? null : Number(row.income),
    todayIncome,
    kills: Number(stats.kills || 0),
    deaths: Number(stats.deaths || 0),
    state: row.state ? {
      hp: state.hp ?? null,
      maxHp: state.max_hp ?? null,
      x: state.x ?? null,
      y: state.y ?? null,
      stamina5s: state.stamina_5s_remaining_milli ?? null,
      stamina1h: state.stamina_1h_remaining_milli ?? null,
      stamina1d: state.stamina_1d_remaining_milli ?? null,
      stamina5sLimit: state.stamina_5s_limit_milli ?? null,
      stamina1hLimit: state.stamina_1h_limit_milli ?? null,
      stamina1dLimit: state.stamina_1d_limit_milli ?? null,
      currentJoinMode: state.current_join_mode ?? null,
      life: state.life ?? null,
      snapshotId: row.snapshot_id,
      observedAt: toDate(row.observed_at)
    } : null
  };
}

class PostgresPanelStore {
  constructor(options = {}) {
    this.pool = options.pool || new Pool({ connectionString: options.connectionString || process.env.DATABASE_URL });
    this.engine = options.engine || new ProjectionEngine(options);
    this.ownsPool = !options.pool;
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }

  async query(text, values) {
    return this.pool.query(text, values);
  }

  async hydrate() {
    const [versionsResult, latestObservedResult, playersResult, statesResult, basesResult, deltasResult, quotaResult, dailyQuotaResult, messagesResult, killsResult, dropsResult, statsResult, namesResult, entitiesResult, intervalsResult, mapResult] = await Promise.all([
      this.query(`SELECT snapshot_id, version_token, server_day::text, reset_generation, server_tick, observed_at, received_at, entity_count, total_entities, bullet_count, coin_drop_count, message_count, payload_hash, completeness, schema_version, duplicate_poll_count, observation_ids, errors FROM snapshot_versions ORDER BY observed_at`),
      this.query(`SELECT server_day::text, reset_generation, server_tick, observed_at FROM snapshot_versions ORDER BY observed_at DESC LIMIT 1`),
      this.query('SELECT user_id, first_seen_at, last_seen_at, current_name, current_entity_id, online, last_snapshot_id, segment_id FROM players'),
      this.query('SELECT user_id, entity_id, segment_id, snapshot_id, server_day::text, reset_generation, online, observed_at, state FROM player_state_current'),
      this.query('SELECT snapshot_id, user_id, segment_id, schema_version, state, observed_at FROM player_state_base ORDER BY observed_at'),
      this.query('SELECT snapshot_id, user_id, segment_id, changed_mask, changed_values, missing_fields, extra, observed_at FROM player_state_delta ORDER BY observed_at'),
      this.query('SELECT user_id, quota_day::text, initial_quota, quota_value, last_drop, last_loss, last_snapshot_id, updated_at FROM player_quota_current'),
      this.query('SELECT local_date::text, user_id, initial_quota, closing_quota, income, finalized_at, source_snapshot_id FROM player_daily_quota'),
      this.query('SELECT server_day::text, message_id, tick, kind, text, user_id, target_user_id, user_name, target_name, event_at, first_observed_snapshot_id, last_observed_snapshot_id, first_observed_at, last_observed_at FROM message_events'),
      this.query('SELECT local_date::text, kill_id, message_id, event_at, server_day::text, tick, killer_user_id, victim_user_id, killer_name, victim_name, confidence, evidence_snapshot_id, drop, victim_position, killer_position, victim_stamina_5s, victim_stamina_5s_limit, parser_version FROM kill_events'),
      this.query('SELECT server_day::text, drop_id, first_seen_snapshot_id, last_seen_snapshot_id, first_seen_at, last_seen_at, disappeared_at, source_user_id, system_spawned, x, y, amount, created_tick, source, confidence, kill_event_id FROM coin_drop_lifecycles'),
      this.query('SELECT local_date::text, user_id, kills, deaths FROM player_daily_stats'),
      this.query('SELECT user_id, name, first_observed_at, last_observed_at FROM player_name_history'),
      this.query('SELECT user_id, entity_id, reset_generation, first_snapshot_id, last_snapshot_id, first_observed_at, last_observed_at FROM player_entity_history'),
      this.query('SELECT user_id, segment_id, server_day::text, online_from_snapshot_id, online_to_snapshot_id, online_from_at, online_to_at, closed_reason FROM player_online_interval ORDER BY online_from_at'),
      this.query('SELECT payload FROM map_metadata ORDER BY updated_at DESC LIMIT 1')
    ]);
    const engine = this.engine;
    engine.reset();
    if (mapResult.rows[0]?.payload) engine.mapMetadata = cloneJson(mapResult.rows[0].payload);
    const versions = versionsResult.rows.map(row => ({
      ...row,
      version_token: row.version_token || row.snapshot_id,
      server_day: String(row.server_day).slice(0, 10),
      observation_ids: row.observation_ids || [],
      errors: row.errors || []
    }));
    engine.versions = versions;
    for (const version of versions) {
      engine.versionByKey.set(`${version.server_day}/${version.reset_generation}/${version.server_tick}/${version.payload_hash}`, version);
    }
    const latestStable = versions.filter(version => version.completeness === 'steady').at(-1) || null;
    const latestObserved = latestObservedResult.rows[0] || null;
    engine.lastStableVersion = latestStable;
    engine.lastParserCursor = latestObserved ? {
      serverDay: String(latestObserved.server_day).slice(0, 10),
      serverTick: Number(latestObserved.server_tick),
      resetGeneration: Number(latestObserved.reset_generation)
    } : null;
    for (const row of playersResult.rows) {
      engine.players.set(String(row.user_id), {
        user_id: Number(row.user_id),
        first_seen_at: toDate(row.first_seen_at),
        last_seen_at: toDate(row.last_seen_at),
        current_name: row.current_name || '',
        current_entity_id: row.current_entity_id === null ? null : Number(row.current_entity_id),
        online: Boolean(row.online),
        last_snapshot_id: row.last_snapshot_id,
        segment_id: row.segment_id
      });
    }
    for (const row of statesResult.rows) {
      const state = {
        ...(row.state || {}),
        user_id: Number(row.user_id),
        entity_id: row.entity_id === null ? null : Number(row.entity_id),
        snapshot_id: row.snapshot_id,
        server_day: String(row.server_day).slice(0, 10),
        reset_generation: Number(row.reset_generation),
        segment_id: row.segment_id,
        observed_at: toDate(row.observed_at),
        online: Boolean(row.online)
      };
      engine.currentStates.set(String(row.user_id), state);
      if (latestStable && row.snapshot_id === latestStable.snapshot_id) engine.lastStableUsers.add(String(row.user_id));
    }
    engine.stateBases = basesResult.rows.map(row => ({
      snapshot_id: row.snapshot_id,
      user_id: Number(row.user_id),
      segment_id: row.segment_id,
      schema_version: row.schema_version,
      state: row.state || {},
      observed_at: toDate(row.observed_at)
    }));
    engine.stateDeltas = deltasResult.rows.map(row => ({
      snapshot_id: row.snapshot_id,
      user_id: Number(row.user_id),
      segment_id: row.segment_id,
      changed_mask: row.changed_mask || [],
      changed_values: row.changed_values || {},
      missing_fields: row.missing_fields || [],
      extra: row.extra || {},
      observed_at: toDate(row.observed_at)
    }));
    for (const row of quotaResult.rows) {
      engine.quotaCurrent.set(String(row.user_id), {
        user_id: Number(row.user_id),
        quota_day: String(row.quota_day).slice(0, 10),
        initial_quota: row.initial_quota === null ? null : Number(row.initial_quota),
        quota_value: row.quota_value === null ? null : Number(row.quota_value),
        last_drop: row.last_drop === null ? null : Number(row.last_drop),
        last_loss: row.last_loss === null ? null : Number(row.last_loss),
        last_snapshot_id: row.last_snapshot_id,
        updated_at: toDate(row.updated_at)
      });
    }
    for (const row of dailyQuotaResult.rows) engine.dailyQuota.set(mapKey(row.local_date, row.user_id), {
      ...row,
      local_date: String(row.local_date).slice(0, 10),
      user_id: Number(row.user_id),
      initial_quota: numberOrNull(row.initial_quota),
      closing_quota: numberOrNull(row.closing_quota),
      income: numberOrNull(row.income),
      finalized_at: row.finalized_at ? toDate(row.finalized_at) : null
    });
    for (const row of namesResult.rows) engine.nameHistory.set(mapKey(row.user_id, row.name), { ...row, user_id: Number(row.user_id) });
    for (const row of entitiesResult.rows) engine.entityHistory.set(mapKey(row.user_id, row.entity_id, row.reset_generation), { ...row, user_id: Number(row.user_id), entity_id: Number(row.entity_id), reset_generation: Number(row.reset_generation) });
    for (const row of messagesResult.rows) engine.messages.set(String(row.message_id), { ...row, message_id: String(row.message_id), server_day: String(row.server_day).slice(0, 10), local_date: String(row.server_day).slice(0, 10), event_at: toDate(row.event_at), first_observed_at: toDate(row.first_observed_at), last_observed_at: toDate(row.last_observed_at) });
    for (const row of killsResult.rows) engine.kills.set(String(row.kill_id), { ...row, kill_id: String(row.kill_id), message_id: String(row.message_id), local_date: String(row.local_date).slice(0, 10), server_day: String(row.server_day).slice(0, 10), event_at: toDate(row.event_at), victim_position: row.victim_position, killer_position: row.killer_position, victim_stamina_5s: row.victim_stamina_5s === null ? null : Number(row.victim_stamina_5s), victim_stamina_5s_limit: row.victim_stamina_5s_limit === null ? null : Number(row.victim_stamina_5s_limit) });
    for (const row of dropsResult.rows) engine.drops.set(mapKey(row.server_day, row.drop_id), { ...row, server_day: String(row.server_day).slice(0, 10), drop_id: Number(row.drop_id), first_seen_at: toDate(row.first_seen_at), last_seen_at: toDate(row.last_seen_at), disappeared_at: row.disappeared_at ? toDate(row.disappeared_at) : null });
    for (const row of statsResult.rows) engine.dailyStats.set(mapKey(row.local_date, row.user_id), { ...row, local_date: String(row.local_date).slice(0, 10), user_id: Number(row.user_id), kills: Number(row.kills), deaths: Number(row.deaths) });
    // Kill events are the durable de-duplicated source for daily stats. This
    // reconstruction also covers a crash after a warming-up kill was stored
    // but before the next steady snapshot could persist its FK-dependent
    // aggregate row.
    const rebuiltStats = new Map();
    for (const kill of engine.kills.values()) {
      const add = (userId, field) => {
        if (userId === null || userId === undefined) return;
        const key = mapKey(kill.local_date, userId);
        const stat = rebuiltStats.get(key) || { local_date: kill.local_date, user_id: Number(userId), kills: 0, deaths: 0 };
        stat[field] += 1;
        rebuiltStats.set(key, stat);
      };
      add(kill.killer_user_id, 'kills');
      add(kill.victim_user_id, 'deaths');
    }
    for (const [key, stat] of rebuiltStats) engine.dailyStats.set(key, stat);
    for (const row of intervalsResult.rows) {
      const interval = { user_id: Number(row.user_id), segment_id: row.segment_id, server_day: String(row.server_day).slice(0, 10), online_from_snapshot_id: row.online_from_snapshot_id, online_to_snapshot_id: row.online_to_snapshot_id, online_from_at: toDate(row.online_from_at), online_to_at: row.online_to_at ? toDate(row.online_to_at) : null, closed_reason: row.closed_reason };
      engine.onlineIntervals.push(interval);
      if (interval.online_to_snapshot_id === null) engine.openIntervals.set(String(row.user_id), interval);
    }
    return { latestStable, latestObserved, users: engine.currentStates.size };
  }

  async getMeta() {
    const [dates, map] = await Promise.all([
      this.query("SELECT DISTINCT server_day::text AS day FROM snapshot_versions WHERE completeness = 'steady' ORDER BY day"),
      this.query('SELECT payload FROM map_metadata ORDER BY updated_at DESC LIMIT 1')
    ]);
    const availableDates = dates.rows.map(row => row.day);
    return {
      map: map.rows[0]?.payload || this.engine.mapMetadata,
      availableDates,
      earliestDate: availableDates[0] || null,
      latestDate: availableDates.at(-1) || null,
      timezone: BUSINESS_TIMEZONE,
      schemaVersion: SCHEMA_VERSION,
      features: { realtime: true, history: true, chat: true, kills: true, quota: true, bulletHistory: false }
    };
  }

  async getLatestVersion() {
    const result = await this.query("SELECT snapshot_id, version_token, server_day::text, reset_generation, server_tick, observed_at, received_at, entity_count, total_entities, bullet_count, coin_drop_count, message_count, payload_hash, completeness, schema_version, duplicate_poll_count, observation_ids, errors FROM snapshot_versions WHERE completeness = 'steady' ORDER BY observed_at DESC LIMIT 1");
    return result.rows[0] || null;
  }

  async getRealtime(versionToken = null) {
    const latest = await this.getLatestVersion();
    if (!latest) return { unchanged: false, versionToken: null, latest: null, players: [], messages: [], kills: [], generatedAt: new Date().toISOString() };
    if (versionToken && versionToken === latest.version_token) return { unchanged: true, versionToken, generatedAt: new Date().toISOString() };
    const [playersResult, messagesResult, killsResult, statsResult, quotaResult, mapResult] = await Promise.all([
      this.query(`SELECT p.user_id, p.current_name, p.last_seen_at, p.current_entity_id, p.online,
          c.server_day::text, c.snapshot_id, c.observed_at, c.state,
          q.quota_day::text, q.initial_quota, q.quota_value,
          d.income
        FROM players p
        LEFT JOIN player_state_current c ON c.user_id = p.user_id
        LEFT JOIN player_quota_current q ON q.user_id = p.user_id
        LEFT JOIN player_daily_quota d ON d.user_id = p.user_id AND d.local_date = $1::date
        WHERE c.server_day = $1::date AND c.online = true`, [latest.server_day]),
      this.query('SELECT server_day::text, message_id, tick, kind, text, user_id, target_user_id, user_name, target_name, event_at, first_observed_snapshot_id, last_observed_snapshot_id FROM message_events WHERE server_day = $1::date ORDER BY event_at, server_day, message_id', [latest.server_day]),
      this.query('SELECT local_date::text, kill_id, message_id, event_at, server_day::text, tick, killer_user_id, victim_user_id, killer_name, victim_name, confidence, evidence_snapshot_id, drop, victim_position, killer_position, victim_stamina_5s, victim_stamina_5s_limit, parser_version FROM kill_events WHERE local_date = $1::date ORDER BY event_at, local_date, kill_id', [latest.server_day]),
      this.query('SELECT local_date::text, user_id, kills, deaths FROM player_daily_stats WHERE local_date = $1::date', [latest.server_day]),
      this.query('SELECT user_id, quota_day::text, initial_quota, quota_value, last_drop, last_loss FROM player_quota_current WHERE quota_day = $1::date', [latest.server_day]),
      this.query('SELECT payload FROM map_metadata ORDER BY updated_at DESC LIMIT 1')
    ]);
    const stats = new Map(statsResult.rows.map(row => [String(row.user_id), row]));
    let players = playersResult.rows.map(row => rowToPlayer(row, stats.get(String(row.user_id)), { currentDay: latest.server_day }));
    players = players.filter(player => {
      const state = player.state;
      const tired = state?.stamina1d !== null && state?.stamina1dLimit !== null && state?.stamina1d < state.stamina1dLimit;
      return (player.drop !== null && player.drop >= 1) || tired;
    });
    return {
      unchanged: false,
      versionToken: latest.version_token,
      generatedAt: new Date().toISOString(),
      latest,
      map: mapResult.rows[0]?.payload || this.engine.mapMetadata,
      players,
      messages: messagesResult.rows,
      kills: killsResult.rows,
      quota: quotaResult.rows,
      stats: statsResult.rows,
      closedThrough: null
    };
  }

  async getHistory(range) {
    const latest = await this.getLatestVersion();
    const currentDay = latest?.server_day ? String(latest.server_day).slice(0, 10) : null;
    const [messages, kills, stats, quota, players] = await Promise.all([
      this.query('SELECT server_day::text, message_id, tick, kind, text, user_id, target_user_id, user_name, target_name, event_at, first_observed_snapshot_id, last_observed_snapshot_id FROM message_events WHERE server_day BETWEEN $1::date AND $2::date ORDER BY event_at, server_day, message_id LIMIT $3', [range.from, range.to, HISTORY_ROW_LIMITS.messages + 1]),
      this.query('SELECT local_date::text, kill_id, message_id, event_at, server_day::text, tick, killer_user_id, victim_user_id, killer_name, victim_name, confidence, evidence_snapshot_id, drop, victim_position, killer_position, victim_stamina_5s, victim_stamina_5s_limit, parser_version FROM kill_events WHERE local_date BETWEEN $1::date AND $2::date ORDER BY event_at, local_date, kill_id LIMIT $3', [range.from, range.to, HISTORY_ROW_LIMITS.kills + 1]),
      this.query('SELECT local_date::text, user_id, SUM(kills)::int AS kills, SUM(deaths)::int AS deaths FROM player_daily_stats WHERE local_date BETWEEN $1::date AND $2::date GROUP BY local_date, user_id ORDER BY local_date, user_id LIMIT $3', [range.from, range.to, HISTORY_ROW_LIMITS.stats + 1]),
      this.query('SELECT local_date::text, user_id, initial_quota, closing_quota, income, finalized_at FROM player_daily_quota WHERE local_date BETWEEN $1::date AND $2::date ORDER BY local_date, user_id LIMIT $3', [range.from, range.to, HISTORY_ROW_LIMITS.dailyQuota + 1]),
      this.query(`WITH ranged_income AS (
          SELECT user_id, SUM(income) AS income
          FROM player_daily_quota
          WHERE local_date BETWEEN $1::date AND $2::date
          GROUP BY user_id
        ), today_income AS (
          SELECT user_id, SUM(income) AS today_income
          FROM player_daily_quota
          WHERE local_date = $3::date
          GROUP BY user_id
        ), player_rows AS (
          SELECT p.user_id, p.current_name, p.last_seen_at, p.current_entity_id, p.online,
            c.server_day::text, c.snapshot_id, c.observed_at, c.state,
            q.quota_day::text, q.initial_quota, q.quota_value,
            ri.income,
            ti.today_income,
            CASE WHEN c.server_day = $3::date
              THEN NULLIF(c.state->>'death_drop_coins', '')::numeric
              ELSE NULL
            END AS current_drop
          FROM players p
          LEFT JOIN player_state_current c ON c.user_id = p.user_id
          LEFT JOIN player_quota_current q ON q.user_id = p.user_id
          LEFT JOIN ranged_income ri ON ri.user_id = p.user_id
          LEFT JOIN today_income ti ON ti.user_id = p.user_id
        ), quota_top AS (
          SELECT user_id FROM player_rows
          WHERE quota_value IS NOT NULL
          ORDER BY quota_value DESC, user_id
          LIMIT 50
        ), drop_top AS (
          SELECT user_id FROM player_rows
          WHERE current_drop IS NOT NULL
          ORDER BY current_drop DESC, user_id
          LIMIT 50
        ), today_income_top AS (
          SELECT user_id FROM player_rows
          WHERE today_income IS NOT NULL
          ORDER BY today_income DESC, user_id
          LIMIT 50
        ), candidates AS (
          SELECT user_id FROM quota_top
          UNION
          SELECT user_id FROM drop_top
          UNION
          SELECT user_id FROM today_income_top
        )
        SELECT pr.*
        FROM player_rows pr
        INNER JOIN candidates candidate ON candidate.user_id = pr.user_id
        ORDER BY pr.user_id
        LIMIT $4`, [range.from, range.to, currentDay, HISTORY_ROW_LIMITS.players + 1])
    ]);
    const messageRows = limitedRows(messages, 'messages', HISTORY_ROW_LIMITS.messages);
    const killRows = limitedRows(kills, 'kills', HISTORY_ROW_LIMITS.kills);
    const statRows = limitedRows(stats, 'stats', HISTORY_ROW_LIMITS.stats);
    const quotaRows = limitedRows(quota, 'dailyQuota', HISTORY_ROW_LIMITS.dailyQuota);
    const playerRows = limitedRows(players, 'players', HISTORY_ROW_LIMITS.players);
    const statMap = new Map();
    for (const row of statRows) {
      const key = String(row.user_id);
      const current = statMap.get(key) || { kills: 0, deaths: 0 };
      current.kills += Number(row.kills || 0);
      current.deaths += Number(row.deaths || 0);
      statMap.set(key, current);
    }
    return {
      from: range.from,
      to: range.to,
      timezone: BUSINESS_TIMEZONE,
      generatedAt: new Date().toISOString(),
      closedThrough: latest && range.to < String(latest.server_day).slice(0, 10) ? range.to : null,
      players: playerRows.map(row => rowToPlayer(row, statMap.get(String(row.user_id)), { currentDay: latest?.server_day })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-u-co-pinyin') || a.userId - b.userId),
      messages: messageRows,
      kills: killRows,
      dailyQuota: quotaRows.map(historyQuotaRow),
      stats: statRows.map(historyStatRow)
    };
  }

  async applyObservation(body, metadata = {}) {
    const beforeAdjustments = this.engine.quotaAdjustments.length;
    const result = this.engine.applyObservation(body, metadata);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const observation = result.observation;
      await client.query(`INSERT INTO snapshot_observations (observation_id, observed_at, received_at, status_code, duration_ms, body_bytes, payload_hash, raw_path, egress_id, egress_group, retry_no, error, schema_version, parse_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (observation_id) DO UPDATE SET parse_status = EXCLUDED.parse_status, error = EXCLUDED.error`, [
        observation.observation_id, observation.observed_at, observation.received_at, observation.status_code, observation.duration_ms, observation.body_bytes, observation.payload_hash, observation.raw_path, observation.egress_id, observation.egress_group, observation.retry_no, observation.error, observation.schema_version, observation.parse_status
      ]);
      if (result.version) {
        const version = result.version;
        await client.query(`INSERT INTO snapshot_versions (snapshot_id, version_token, server_day, reset_generation, server_tick, observed_at, received_at, entity_count, total_entities, bullet_count, coin_drop_count, message_count, payload_hash, completeness, schema_version, duplicate_poll_count, observation_ids, errors)
          VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb)
          ON CONFLICT (snapshot_id) DO UPDATE SET duplicate_poll_count = EXCLUDED.duplicate_poll_count, observation_ids = EXCLUDED.observation_ids`, [
          version.snapshot_id, version.version_token, version.server_day, version.reset_generation, version.server_tick, version.observed_at, version.received_at, version.entity_count, version.total_entities, version.bullet_count, version.coin_drop_count, version.message_count, version.payload_hash, version.completeness, version.schema_version, version.duplicate_poll_count, JSON.stringify(version.observation_ids), JSON.stringify(version.errors)
        ]);
      }
      if (result.status === 'projected') await this.persistProjected(client, result, beforeAdjustments);
      else if (result.status === 'warming_up') await this.persistWarmingEvents(client, result);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      // The in-memory projector was advanced before the SQL transaction. If
      // the transaction failed, rebuild it from committed rows before the
      // queue retries this observation; otherwise a retry could be mistaken
      // for an already-persisted duplicate.
      try { await this.hydrate(); } catch (_) { /* preserve the original error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async persistProjected(client, result, beforeAdjustments) {
    const { parsed, version } = result;
    const configuredMap = loadMapMetadata();
    if (configuredMap) this.engine.mapMetadata = configuredMap;
    for (const entity of parsed.entities) {
      const player = this.engine.players.get(String(entity.user_id));
      const state = this.engine.currentStates.get(String(entity.user_id));
      await client.query(`INSERT INTO players (user_id, first_seen_at, last_seen_at, current_name, current_entity_id, online, last_snapshot_id, segment_id, updated_at)
        VALUES ($1, $2, $2, $3, $4, true, $5, $6, now())
        ON CONFLICT (user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, current_name = EXCLUDED.current_name, current_entity_id = EXCLUDED.current_entity_id, online = true, last_snapshot_id = EXCLUDED.last_snapshot_id, segment_id = EXCLUDED.segment_id, updated_at = now()`, [entity.user_id, version.observed_at, player.current_name, entity.entity_id, version.snapshot_id, state.segment_id]);
      const name = this.engine.nameHistory.get(mapKey(entity.user_id, entity.name || ''));
      await client.query(`INSERT INTO player_name_history (user_id, name, first_observed_at, last_observed_at) VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, name) DO UPDATE SET last_observed_at = EXCLUDED.last_observed_at`, [entity.user_id, entity.name || '', name.first_observed_at, name.last_observed_at]);
      const entityHistory = this.engine.entityHistory.get(mapKey(entity.user_id, entity.entity_id, parsed.resetGeneration));
      await client.query(`INSERT INTO player_entity_history (user_id, entity_id, reset_generation, first_snapshot_id, last_snapshot_id, first_observed_at, last_observed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, entity_id, reset_generation) DO UPDATE SET last_snapshot_id = EXCLUDED.last_snapshot_id, last_observed_at = EXCLUDED.last_observed_at`, [entity.user_id, entity.entity_id, parsed.resetGeneration, entityHistory.first_snapshot_id, entityHistory.last_snapshot_id, entityHistory.first_observed_at, entityHistory.last_observed_at]);
      await client.query(`INSERT INTO player_state_current (user_id, entity_id, segment_id, snapshot_id, server_day, reset_generation, online, observed_at, state, updated_at)
        VALUES ($1, $2, $3, $4, $5::date, $6, true, $7, $8::jsonb, now())
        ON CONFLICT (user_id) DO UPDATE SET entity_id = EXCLUDED.entity_id, segment_id = EXCLUDED.segment_id, snapshot_id = EXCLUDED.snapshot_id, server_day = EXCLUDED.server_day, reset_generation = EXCLUDED.reset_generation, online = true, observed_at = EXCLUDED.observed_at, state = EXCLUDED.state, updated_at = now()`, [entity.user_id, entity.entity_id, state.segment_id, version.snapshot_id, parsed.serverDay, parsed.resetGeneration, version.observed_at, JSON.stringify(entity)]);
    }
    for (const userId of this.engine.lastClosedUsers) {
      await client.query('UPDATE players SET online = false, updated_at = now() WHERE user_id = $1', [userId]);
      await client.query('UPDATE player_state_current SET online = false, updated_at = now() WHERE user_id = $1', [userId]);
    }
    for (const base of this.engine.stateBases.filter(item => item.snapshot_id === parsed.snapshotId)) {
      await client.query(`INSERT INTO player_state_base (snapshot_id, user_id, segment_id, schema_version, state, observed_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT DO NOTHING`, [base.snapshot_id, base.user_id, base.segment_id, base.schema_version, JSON.stringify(base.state), base.observed_at]);
    }
    for (const delta of this.engine.stateDeltas.filter(item => item.snapshot_id === parsed.snapshotId)) {
      await client.query(`INSERT INTO player_state_delta (snapshot_id, user_id, segment_id, changed_mask, changed_values, missing_fields, extra, observed_at) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8) ON CONFLICT DO NOTHING`, [delta.snapshot_id, delta.user_id, delta.segment_id, JSON.stringify(delta.changed_mask), JSON.stringify(delta.changed_values), JSON.stringify(delta.missing_fields), JSON.stringify(delta.extra), delta.observed_at]);
    }
    for (const interval of this.engine.onlineIntervals.filter(item => item.online_from_snapshot_id === parsed.snapshotId)) {
      await client.query(`INSERT INTO player_online_interval (user_id, segment_id, server_day, online_from_snapshot_id, online_to_snapshot_id, online_from_at, online_to_at, closed_reason) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)`, [interval.user_id, interval.segment_id, interval.server_day, interval.online_from_snapshot_id, interval.online_to_snapshot_id, interval.online_from_at, interval.online_to_at, interval.closed_reason]);
    }
    for (const interval of this.engine.lastTouchedIntervals) {
      await client.query(`UPDATE player_online_interval SET online_to_snapshot_id = $1, online_to_at = $2, closed_reason = $3 WHERE user_id = $4 AND segment_id = $5 AND online_from_snapshot_id = $6`, [interval.online_to_snapshot_id, interval.online_to_at, interval.closed_reason, interval.user_id, interval.segment_id, interval.online_from_snapshot_id]);
    }
    for (const message of this.engine.messages.values()) {
      if (message.last_observed_snapshot_id !== parsed.snapshotId) continue;
      await client.query(`INSERT INTO message_events (server_day, message_id, tick, kind, text, user_id, target_user_id, user_name, target_name, event_at, first_observed_snapshot_id, last_observed_snapshot_id, first_observed_at, last_observed_at)
        VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (server_day, message_id) DO UPDATE SET last_observed_snapshot_id = EXCLUDED.last_observed_snapshot_id, last_observed_at = EXCLUDED.last_observed_at`, [message.server_day, message.message_id.split(':').at(-1), message.tick, message.kind, message.text, message.user_id, message.target_user_id, message.user_name, message.target_name, message.event_at, message.first_observed_snapshot_id, message.last_observed_snapshot_id, message.first_observed_at, message.last_observed_at]);
    }
    for (const kill of this.engine.lastTouchedKills) {
      await client.query(`INSERT INTO kill_events (local_date, kill_id, message_id, event_at, server_day, tick, killer_user_id, victim_user_id, killer_name, victim_name, confidence, evidence_snapshot_id, drop, victim_position, killer_position, victim_stamina_5s, victim_stamina_5s_limit, parser_version)
        VALUES ($1::date, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18) ON CONFLICT (local_date, kill_id) DO UPDATE SET evidence_snapshot_id = EXCLUDED.evidence_snapshot_id, drop = COALESCE(EXCLUDED.drop, kill_events.drop), victim_position = COALESCE(EXCLUDED.victim_position, kill_events.victim_position), killer_position = COALESCE(EXCLUDED.killer_position, kill_events.killer_position), victim_stamina_5s = COALESCE(EXCLUDED.victim_stamina_5s, kill_events.victim_stamina_5s), victim_stamina_5s_limit = COALESCE(EXCLUDED.victim_stamina_5s_limit, kill_events.victim_stamina_5s_limit)`, [kill.local_date, kill.kill_id, kill.message_id, kill.event_at, kill.server_day, kill.tick, kill.killer_user_id, kill.victim_user_id, kill.killer_name, kill.victim_name, kill.confidence, kill.evidence_snapshot_id, JSON.stringify(kill.drop), JSON.stringify(kill.victim_position), JSON.stringify(kill.killer_position), kill.victim_stamina_5s, kill.victim_stamina_5s_limit, kill.parser_version]);
    }
    for (const drop of this.engine.lastTouchedDrops) {
      await client.query(`INSERT INTO coin_drop_lifecycles (server_day, drop_id, first_seen_snapshot_id, last_seen_snapshot_id, first_seen_at, last_seen_at, disappeared_at, source_user_id, system_spawned, x, y, amount, created_tick, source, confidence, kill_event_id)
        VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ON CONFLICT (server_day, drop_id) DO UPDATE SET last_seen_snapshot_id = EXCLUDED.last_seen_snapshot_id, last_seen_at = EXCLUDED.last_seen_at, disappeared_at = EXCLUDED.disappeared_at, kill_event_id = EXCLUDED.kill_event_id`, [drop.server_day, drop.drop_id, drop.first_seen_snapshot_id, drop.last_seen_snapshot_id, drop.first_seen_at, drop.last_seen_at, drop.disappeared_at, drop.source_user_id, drop.system_spawned, drop.x, drop.y, drop.amount, drop.created_tick, drop.source, drop.confidence, drop.kill_event_id]);
    }
    for (const stat of this.engine.dailyStats.values()) {
      if (stat.local_date !== parsed.serverDay) continue;
      // A warming-up message may refer to a user that has not yet appeared in
      // a stable entity set. Keep its kill event, but wait for the player row
      // before satisfying the deliberate daily-stats foreign key.
      if (!this.engine.players.has(String(stat.user_id))) continue;
      await client.query(`INSERT INTO player_daily_stats (local_date, user_id, kills, deaths) VALUES ($1::date, $2, $3, $4) ON CONFLICT (local_date, user_id) DO UPDATE SET kills = EXCLUDED.kills, deaths = EXCLUDED.deaths`, [stat.local_date, stat.user_id, stat.kills, stat.deaths]);
    }
    for (const quota of this.engine.quotaCurrent.values()) {
      if (quota.quota_day !== parsed.serverDay) continue;
      await client.query(`INSERT INTO player_quota_current (user_id, quota_day, initial_quota, quota_value, last_drop, last_loss, last_snapshot_id, updated_at) VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8) ON CONFLICT (user_id) DO UPDATE SET quota_day = EXCLUDED.quota_day, initial_quota = EXCLUDED.initial_quota, quota_value = EXCLUDED.quota_value, last_drop = EXCLUDED.last_drop, last_loss = EXCLUDED.last_loss, last_snapshot_id = EXCLUDED.last_snapshot_id, updated_at = EXCLUDED.updated_at`, [quota.user_id, quota.quota_day, quota.initial_quota, quota.quota_value, quota.last_drop, quota.last_loss, quota.last_snapshot_id, quota.updated_at]);
    }
    for (const adjustment of this.engine.quotaAdjustments.slice(beforeAdjustments)) {
      await client.query(`INSERT INTO player_quota_adjustments (user_id, local_date, snapshot_id, observed_at, drop_before, drop_after, loss_before, adjustment, reason, computable) VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10)`, [adjustment.user_id, adjustment.local_date, adjustment.snapshot_id, adjustment.observed_at, adjustment.drop_before, adjustment.drop_after, adjustment.loss_before, adjustment.adjustment, adjustment.reason, adjustment.computable]);
    }
    for (const daily of this.engine.dailyQuota.values()) {
      if (daily.local_date !== parsed.serverDay) continue;
      await client.query(`INSERT INTO player_daily_quota (local_date, user_id, initial_quota, closing_quota, income, finalized_at, source_snapshot_id) VALUES ($1::date, $2, $3, $4, $5, $6, $7) ON CONFLICT (local_date, user_id) DO UPDATE SET closing_quota = EXCLUDED.closing_quota, income = EXCLUDED.income, finalized_at = COALESCE(player_daily_quota.finalized_at, EXCLUDED.finalized_at), source_snapshot_id = EXCLUDED.source_snapshot_id`, [daily.local_date, daily.user_id, daily.initial_quota, daily.closing_quota, daily.income, daily.finalized_at, daily.source_snapshot_id]);
    }
    await client.query(`INSERT INTO map_metadata (map_id, version, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (map_id, version) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`, [this.engine.mapMetadata.id, this.engine.mapMetadata.version, JSON.stringify(this.engine.mapMetadata)]);
  }

  async persistWarmingEvents(client, result) {
    const { parsed } = result;
    for (const message of this.engine.messages.values()) {
      if (message.last_observed_snapshot_id !== parsed.snapshotId) continue;
      await client.query(`INSERT INTO message_events (server_day, message_id, tick, kind, text, user_id, target_user_id, user_name, target_name, event_at, first_observed_snapshot_id, last_observed_snapshot_id, first_observed_at, last_observed_at)
        VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (server_day, message_id) DO UPDATE SET last_observed_snapshot_id = EXCLUDED.last_observed_snapshot_id, last_observed_at = EXCLUDED.last_observed_at`, [message.server_day, message.message_id.split(':').at(-1), message.tick, message.kind, message.text, message.user_id, message.target_user_id, message.user_name, message.target_name, message.event_at, message.first_observed_snapshot_id, message.last_observed_snapshot_id, message.first_observed_at, message.last_observed_at]);
    }
    for (const kill of this.engine.lastTouchedKills) {
      await client.query(`INSERT INTO kill_events (local_date, kill_id, message_id, event_at, server_day, tick, killer_user_id, victim_user_id, killer_name, victim_name, confidence, evidence_snapshot_id, drop, victim_position, killer_position, victim_stamina_5s, victim_stamina_5s_limit, parser_version)
        VALUES ($1::date, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18) ON CONFLICT (local_date, kill_id) DO UPDATE SET evidence_snapshot_id = EXCLUDED.evidence_snapshot_id, drop = COALESCE(EXCLUDED.drop, kill_events.drop), victim_position = COALESCE(EXCLUDED.victim_position, kill_events.victim_position), killer_position = COALESCE(EXCLUDED.killer_position, kill_events.killer_position), victim_stamina_5s = COALESCE(EXCLUDED.victim_stamina_5s, kill_events.victim_stamina_5s), victim_stamina_5s_limit = COALESCE(EXCLUDED.victim_stamina_5s_limit, kill_events.victim_stamina_5s_limit)`, [kill.local_date, kill.kill_id, kill.message_id, kill.event_at, kill.server_day, kill.tick, kill.killer_user_id, kill.victim_user_id, kill.killer_name, kill.victim_name, kill.confidence, kill.evidence_snapshot_id, JSON.stringify(kill.drop), JSON.stringify(kill.victim_position), JSON.stringify(kill.killer_position), kill.victim_stamina_5s, kill.victim_stamina_5s_limit, kill.parser_version]);
    }
    for (const drop of this.engine.lastTouchedDrops) {
      await client.query(`INSERT INTO coin_drop_lifecycles (server_day, drop_id, first_seen_snapshot_id, last_seen_snapshot_id, first_seen_at, last_seen_at, disappeared_at, source_user_id, system_spawned, x, y, amount, created_tick, source, confidence, kill_event_id)
        VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ON CONFLICT (server_day, drop_id) DO UPDATE SET last_seen_snapshot_id = EXCLUDED.last_seen_snapshot_id, last_seen_at = EXCLUDED.last_seen_at, disappeared_at = COALESCE(EXCLUDED.disappeared_at, coin_drop_lifecycles.disappeared_at), kill_event_id = COALESCE(EXCLUDED.kill_event_id, coin_drop_lifecycles.kill_event_id)`, [drop.server_day, drop.drop_id, drop.first_seen_snapshot_id, drop.last_seen_snapshot_id, drop.first_seen_at, drop.last_seen_at, drop.disappeared_at, drop.source_user_id, drop.system_spawned, drop.x, drop.y, drop.amount, drop.created_tick, drop.source, drop.confidence, drop.kill_event_id]);
    }
    // Warming-up messages can mention users that are not in the incomplete
    // entity set yet. Their daily stats are persisted by the next stable
    // projection after the corresponding players exist (the FK is deliberate).
  }
}

module.exports = { HISTORY_ROW_LIMITS, PostgresPanelStore, rowToPlayer };
