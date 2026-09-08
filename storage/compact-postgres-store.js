'use strict';

const { Pool } = require('pg');
const { ProjectionEngine, loadMapMetadata } = require('../domain/projector');
const { BUSINESS_TIMEZONE, SCHEMA_VERSION, cloneJson, presetRangesForDates } = require('../domain/snapshot');
const { rowToPlayer, HISTORY_ROW_LIMITS } = require('./postgres-store');

const CANDIDATE_LIMIT = 50;
const EXTERNAL_BALANCE_PER_QUOTA = 500_000;

const MESSAGE_COLUMNS = `server_day::text, message_id, tick, kind, text, user_id, target_user_id,
  user_name, target_name, event_at, first_observed_at, last_observed_at`;
const KILL_COLUMNS = `ke.local_date::text, ke.kill_id, ke.message_id, ke.event_at, ke.server_day::text, ke.tick,
  ke.killer_user_id, ke.victim_user_id,
  COALESCE(ke.killer_name, NULLIF(pk.current_name, '')) AS killer_name,
  COALESCE(ke.victim_name, NULLIF(pv.current_name, '')) AS victim_name,
  ke.confidence, ke.drop_amount, ke.drop_confidence,
  CASE WHEN ke.drop_amount IS NULL AND ke.drop_confidence IS NULL THEN NULL
       ELSE jsonb_build_object('amount', ke.drop_amount, 'confidence', ke.drop_confidence) END AS drop,
  CASE WHEN ke.victim_x IS NULL AND ke.victim_y IS NULL THEN NULL
       ELSE jsonb_build_object('x', ke.victim_x, 'y', ke.victim_y) END AS victim_position,
  CASE WHEN ke.killer_x IS NULL AND ke.killer_y IS NULL THEN NULL
       ELSE jsonb_build_object('x', ke.killer_x, 'y', ke.killer_y) END AS killer_position,
  ke.victim_stamina_5s, ke.victim_stamina_5s_limit, ke.parser_version`;
const KILL_FROM = 'FROM panel_kill_events ke LEFT JOIN panel_player_current pk ON pk.user_id = ke.killer_user_id LEFT JOIN panel_player_current pv ON pv.user_id = ke.victim_user_id';

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stateJson(alias = 'pc') {
  return `jsonb_build_object(
    'hp', ${alias}.hp, 'max_hp', ${alias}.max_hp, 'x', ${alias}.x, 'y', ${alias}.y,
    'invulnerable_remaining_secs', ${alias}.invulnerable_remaining_secs,
    'death_loss_preview', ${alias}.death_loss_preview,
    'death_drop_coins', ${alias}.death_drop_coins,
    'external_balance_snapshot', ${alias}.external_balance_snapshot,
    'stamina_5s_remaining_milli', ${alias}.stamina_5s,
    'stamina_1h_remaining_milli', ${alias}.stamina_1h,
    'stamina_1d_remaining_milli', ${alias}.stamina_1d,
    'stamina_5s_limit_milli', ${alias}.stamina_5s_limit,
    'stamina_1h_limit_milli', ${alias}.stamina_1h_limit,
    'stamina_1d_limit_milli', ${alias}.stamina_1d_limit,
    'current_join_mode', ${alias}.current_join_mode, 'life', ${alias}.life
  )`;
}

function currentColumns(alias = 'pc') {
  return `${alias}.user_id, ${alias}.current_name, ${alias}.last_seen_at,
    ${alias}.current_entity_id, ${alias}.online, ${alias}.server_day::text,
    ${alias}.state_snapshot_id AS snapshot_id, ${alias}.state_observed_at AS observed_at,
    ${alias}.reset_generation,
    ${stateJson(alias)} AS state,
    ${alias}.quota_day::text, ${alias}.initial_quota, ${alias}.quota_value,
    ${alias}.today_income AS income, ${alias}.today_kills AS kills, ${alias}.today_deaths AS deaths`;
}

function toState(entity, parsed, version, segmentId, online = true) {
  return {
    ...entity,
    snapshot_id: parsed.snapshotId,
    observed_at: version.observed_at,
    server_day: parsed.serverDay,
    reset_generation: parsed.resetGeneration,
    entity_id: entity.entity_id,
    segment_id: segmentId,
    online
  };
}

function compactEngine(engine) {
  // The compact store does not rebuild a base/delta chain after restart. Keep
  // only the maps used by the live projector and the event/daily facts.
  engine.stateBases = [];
  engine.stateDeltas = [];
  engine.onlineIntervals = [];
  engine.openIntervals = new Map();
  engine.entityHistory = new Map();
  engine.nameHistory = new Map();
  engine.observations = [];
}

class CompactPostgresPanelStore {
  constructor(options = {}) {
    this.pool = options.pool || new Pool({ connectionString: options.connectionString || process.env.DATABASE_URL });
    this.engine = options.engine || new ProjectionEngine(options);
    this.ownsPool = !options.pool;
  }

  async close() { if (this.ownsPool) await this.pool.end(); }
  async query(text, values) { return this.pool.query(text, values); }
  stats() { return { storage: 'compact-v2', tables: ['panel_player_current', 'panel_daily_summary', 'panel_message_events', 'panel_kill_events', 'panel_version_dedupe'] }; }

  async hydrate() {
    const [versions, players, messages, kills, summaries, map] = await Promise.all([
      this.query(`SELECT snapshot_id, snapshot_key, version_token, server_day::text, reset_generation, server_tick,
          observed_at, received_at, entity_count, total_entities, bullet_count, coin_drop_count,
          message_count, payload_hash, completeness, schema_version, duplicate_poll_count
        FROM panel_version_dedupe ORDER BY observed_at`),
      this.query(`SELECT ${currentColumns('pc')} FROM panel_player_current pc`),
      this.query(`SELECT ${MESSAGE_COLUMNS} FROM panel_message_events`),
      this.query(`SELECT ${KILL_COLUMNS} ${KILL_FROM}`),
      this.query(`SELECT local_date::text, user_id, kills, deaths, initial_quota, closing_quota, income,
          quota_status, quota_top_candidate, finalized_at, source_snapshot_id
        FROM panel_daily_summary`),
      this.query('SELECT payload FROM panel_map_metadata ORDER BY updated_at DESC LIMIT 1')
    ]);
    this.engine.reset();
    if (map.rows[0]?.payload) this.engine.mapMetadata = cloneJson(map.rows[0].payload);
    this.engine.versions = versions.rows.map(row => ({
      ...row,
      snapshot_key: row.snapshot_key,
      version_token: row.version_token || row.snapshot_id,
      server_day: String(row.server_day).slice(0, 10),
      observation_ids: [],
      errors: []
    }));
    this.engine.versionByKey = new Map(this.engine.versions.map(row => [row.snapshot_key, row]));
    this.engine.lastVersion = this.engine.versions.at(-1) || null;
    this.engine.lastStableVersion = [...this.engine.versions].reverse().find(row => row.completeness === 'steady') || null;
    const latest = this.engine.lastVersion;
    this.engine.lastParserCursor = latest ? { serverDay: latest.server_day, serverTick: Number(latest.server_tick), resetGeneration: Number(latest.reset_generation) } : null;
    for (const row of players.rows) {
      const uid = String(row.user_id);
      this.engine.players.set(uid, {
        user_id: Number(row.user_id), first_seen_at: row.first_seen_at, last_seen_at: row.last_seen_at,
        current_name: row.current_name || '', current_entity_id: row.current_entity_id === null ? null : Number(row.current_entity_id),
        online: Boolean(row.online), last_snapshot_id: row.snapshot_id, segment_id: `compact-${uid}`
      });
      if (row.snapshot_id) {
        this.engine.currentStates.set(uid, {
          ...(row.state || {}), user_id: Number(row.user_id), entity_id: row.current_entity_id,
          snapshot_id: row.snapshot_id, observed_at: row.observed_at, server_day: row.server_day,
          reset_generation: row.reset_generation, segment_id: `compact-${uid}`, online: Boolean(row.online)
        });
      }
      if (latest?.server_day === row.server_day && row.online) this.engine.lastStableUsers.add(uid);
      if (row.quota_day) this.engine.quotaCurrent.set(uid, {
        user_id: Number(row.user_id), quota_day: String(row.quota_day).slice(0, 10),
        initial_quota: numberOrNull(row.initial_quota), quota_value: numberOrNull(row.quota_value),
        quota_source: 'external_balance_snapshot', last_snapshot_id: row.snapshot_id, updated_at: row.observed_at
      });
    }
    for (const row of messages.rows) {
      this.engine.messages.set(String(row.message_id), { ...row, message_id: String(row.message_id), server_day: String(row.server_day).slice(0, 10), local_date: String(row.server_day).slice(0, 10) });
    }
    for (const row of kills.rows) {
      this.engine.kills.set(String(row.kill_id), {
        ...row, kill_id: String(row.kill_id), local_date: String(row.local_date).slice(0, 10),
        server_day: String(row.server_day).slice(0, 10),
        drop: row.drop, victim_position: row.victim_position, killer_position: row.killer_position
      });
    }
    for (const row of summaries.rows) {
      const localDate = String(row.local_date).slice(0, 10);
      const uid = Number(row.user_id);
      if (Number(row.kills || 0) !== 0 || Number(row.deaths || 0) !== 0) this.engine.dailyStats.set(`${localDate}:${uid}`, { local_date: localDate, user_id: uid, kills: Number(row.kills || 0), deaths: Number(row.deaths || 0) });
      if (row.quota_status !== 'absent') this.engine.dailyQuota.set(`${localDate}:${uid}`, {
        local_date: localDate, user_id: uid, initial_quota: numberOrNull(row.initial_quota), closing_quota: numberOrNull(row.closing_quota),
        income: row.income === null ? null : numberOrNull(row.income), finalized_at: row.finalized_at, source_snapshot_id: row.source_snapshot_id
      });
    }
    compactEngine(this.engine);
    return { latestStable: this.engine.lastStableVersion, latestObserved: this.engine.lastVersion, users: this.engine.currentStates.size };
  }

  async getLatestVersion() {
    const result = await this.query(`SELECT snapshot_id, version_token, server_day::text, reset_generation, server_tick,
        observed_at, received_at, entity_count, total_entities, bullet_count, coin_drop_count, message_count,
        payload_hash, completeness, schema_version, duplicate_poll_count
      FROM panel_version_dedupe ORDER BY observed_at DESC LIMIT 1`);
    return result.rows[0] || null;
  }

  async getMeta() {
    const [dates, map] = await Promise.all([
      this.query('SELECT server_day::text AS day FROM panel_day_status ORDER BY server_day'),
      this.query('SELECT payload FROM panel_map_metadata ORDER BY updated_at DESC LIMIT 1')
    ]);
    const availableDates = dates.rows.map(row => String(row.day).slice(0, 10));
    return {
      map: map.rows[0]?.payload || this.engine.mapMetadata,
      availableDates,
      earliestDate: availableDates[0] || null,
      latestDate: availableDates.at(-1) || null,
      presetRanges: presetRangesForDates(availableDates.at(-1) || null, availableDates),
      timezone: BUSINESS_TIMEZONE,
      schemaVersion: SCHEMA_VERSION,
      features: { realtime: true, history: true, chat: true, kills: true, quota: true, bulletHistory: false }
    };
  }

  async upsertVersion(client, version, parsed) {
    const key = parsed.snapshotKey;
    await client.query(`INSERT INTO panel_version_dedupe (
        snapshot_id, snapshot_key, version_token, server_day, reset_generation, server_tick,
        observed_at, received_at, entity_count, total_entities, bullet_count, coin_drop_count,
        message_count, payload_hash, completeness, schema_version, duplicate_poll_count
      ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0)
      ON CONFLICT (snapshot_key) DO UPDATE SET duplicate_poll_count = panel_version_dedupe.duplicate_poll_count + 1`, [
      version.snapshot_id, key, version.version_token, version.server_day, version.reset_generation, version.server_tick,
      version.observed_at, version.received_at, version.entity_count, version.total_entities, version.bullet_count,
      version.coin_drop_count, version.message_count, version.payload_hash, version.completeness, version.schema_version
    ]);
    await client.query(`INSERT INTO panel_day_status (server_day, first_observed_at, last_observed_at, version_count, latest_version_token)
      VALUES ($1::date,$2,$2,1,$3)
      ON CONFLICT (server_day) DO UPDATE SET first_observed_at = LEAST(panel_day_status.first_observed_at, EXCLUDED.first_observed_at),
        last_observed_at = GREATEST(panel_day_status.last_observed_at, EXCLUDED.last_observed_at),
        version_count = panel_day_status.version_count + CASE WHEN EXCLUDED.latest_version_token = panel_day_status.latest_version_token THEN 0 ELSE 1 END,
        latest_version_token = CASE WHEN EXCLUDED.latest_version_token = panel_day_status.latest_version_token THEN panel_day_status.latest_version_token ELSE EXCLUDED.latest_version_token END,
        updated_at = now()`, [version.server_day, version.observed_at, version.version_token]);
  }

  async upsertCurrent(client, entity, parsed, version, state, online = true) {
    const uid = String(entity.user_id);
    const player = this.engine.players.get(uid) || { first_seen_at: version.observed_at, current_name: entity.name || '' };
    const quota = this.engine.quotaCurrent.get(uid) || null;
    const daily = this.engine.dailyQuota.get(`${parsed.serverDay}:${uid}`) || null;
    const stat = this.engine.dailyStats.get(`${parsed.serverDay}:${uid}`) || null;
    await client.query(`INSERT INTO panel_player_current (
      user_id, current_name, first_seen_at, last_seen_at, current_entity_id, online,
      server_day, state_snapshot_id, state_observed_at, reset_generation,
      x, y, hp, max_hp, invulnerable_remaining_secs, stamina_5s, stamina_5s_limit,
      stamina_1h, stamina_1h_limit, stamina_1d, stamina_1d_limit, current_join_mode, life,
      death_drop_coins, death_loss_preview, external_balance_snapshot,
      quota_day, initial_quota, quota_value, quota_source,
      today_kills, today_deaths, today_income, today_quota_known, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::date,$28,$29,$30,$31,$32,$33,$34,now())
    ON CONFLICT (user_id) DO UPDATE SET current_name=EXCLUDED.current_name,last_seen_at=EXCLUDED.last_seen_at,
      current_entity_id=EXCLUDED.current_entity_id,online=EXCLUDED.online,server_day=EXCLUDED.server_day,
      state_snapshot_id=EXCLUDED.state_snapshot_id,state_observed_at=EXCLUDED.state_observed_at,reset_generation=EXCLUDED.reset_generation,
      x=EXCLUDED.x,y=EXCLUDED.y,hp=EXCLUDED.hp,max_hp=EXCLUDED.max_hp,invulnerable_remaining_secs=EXCLUDED.invulnerable_remaining_secs,
      stamina_5s=EXCLUDED.stamina_5s,stamina_5s_limit=EXCLUDED.stamina_5s_limit,stamina_1h=EXCLUDED.stamina_1h,stamina_1h_limit=EXCLUDED.stamina_1h_limit,
      stamina_1d=EXCLUDED.stamina_1d,stamina_1d_limit=EXCLUDED.stamina_1d_limit,current_join_mode=EXCLUDED.current_join_mode,life=EXCLUDED.life,
      death_drop_coins=EXCLUDED.death_drop_coins,death_loss_preview=EXCLUDED.death_loss_preview,external_balance_snapshot=EXCLUDED.external_balance_snapshot,
      quota_day=EXCLUDED.quota_day,initial_quota=EXCLUDED.initial_quota,quota_value=EXCLUDED.quota_value,quota_source=EXCLUDED.quota_source,
      today_kills=EXCLUDED.today_kills,today_deaths=EXCLUDED.today_deaths,today_income=EXCLUDED.today_income,today_quota_known=EXCLUDED.today_quota_known,updated_at=now()`, [
      entity.user_id, entity.name || player.current_name || '', player.first_seen_at || version.observed_at, version.observed_at,
      entity.entity_id, online, parsed.serverDay, parsed.snapshotId, version.observed_at, parsed.resetGeneration,
      numberOrNull(entity.x), numberOrNull(entity.y), numberOrNull(entity.hp), numberOrNull(entity.max_hp), numberOrNull(entity.invulnerable_remaining_secs),
      numberOrNull(entity.stamina_5s_remaining_milli), numberOrNull(entity.stamina_5s_limit_milli), numberOrNull(entity.stamina_1h_remaining_milli), numberOrNull(entity.stamina_1h_limit_milli),
      numberOrNull(entity.stamina_1d_remaining_milli), numberOrNull(entity.stamina_1d_limit_milli), entity.current_join_mode || null, entity.life || null,
      numberOrNull(entity.death_drop_coins), numberOrNull(entity.death_loss_preview), numberOrNull(entity.external_balance_snapshot),
      quota?.quota_day || parsed.serverDay, quota?.initial_quota ?? null, quota?.quota_value ?? null, quota?.quota_source || 'external_balance_snapshot',
      stat?.kills || 0, stat?.deaths || 0, daily?.income ?? null, daily ? daily.income !== null : null
    ]);
  }

  async upsertMessage(client, message) {
    await client.query(`INSERT INTO panel_message_events (server_day,message_id,tick,kind,text,user_id,target_user_id,user_name,target_name,event_at,first_observed_at,last_observed_at)
      VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (server_day,message_id) DO UPDATE SET user_name=COALESCE(EXCLUDED.user_name,panel_message_events.user_name),target_name=COALESCE(EXCLUDED.target_name,panel_message_events.target_name),last_observed_at=EXCLUDED.last_observed_at`, [
      message.server_day, Number(message.message_id), message.tick, message.kind, message.text, message.user_id, message.target_user_id,
      message.user_name, message.target_name, message.event_at, message.first_observed_at || message.last_observed_at, message.last_observed_at
    ]);
  }

  async upsertKill(client, kill) {
    const drop = kill.drop || {};
    const victim = kill.victim_position || {};
    const killer = kill.killer_position || {};
    await client.query(`INSERT INTO panel_kill_events (local_date,kill_id,message_id,event_at,server_day,tick,killer_user_id,victim_user_id,killer_name,victim_name,confidence,drop_amount,drop_confidence,victim_x,victim_y,killer_x,killer_y,victim_stamina_5s,victim_stamina_5s_limit,parser_version)
      VALUES ($1::date,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (local_date,kill_id) DO UPDATE SET killer_name=COALESCE(EXCLUDED.killer_name,panel_kill_events.killer_name),victim_name=COALESCE(EXCLUDED.victim_name,panel_kill_events.victim_name),drop_amount=COALESCE(EXCLUDED.drop_amount,panel_kill_events.drop_amount),drop_confidence=COALESCE(EXCLUDED.drop_confidence,panel_kill_events.drop_confidence),victim_x=COALESCE(EXCLUDED.victim_x,panel_kill_events.victim_x),victim_y=COALESCE(EXCLUDED.victim_y,panel_kill_events.victim_y),killer_x=COALESCE(EXCLUDED.killer_x,panel_kill_events.killer_x),killer_y=COALESCE(EXCLUDED.killer_y,panel_kill_events.killer_y),victim_stamina_5s=COALESCE(EXCLUDED.victim_stamina_5s,panel_kill_events.victim_stamina_5s),victim_stamina_5s_limit=COALESCE(EXCLUDED.victim_stamina_5s_limit,panel_kill_events.victim_stamina_5s_limit)`, [
      kill.local_date, kill.kill_id, kill.message_id, kill.event_at, kill.server_day, kill.tick, kill.killer_user_id, kill.victim_user_id,
      kill.killer_name, kill.victim_name, kill.confidence, numberOrNull(drop.amount), drop.confidence || null,
      numberOrNull(victim.x), numberOrNull(victim.y), numberOrNull(killer.x), numberOrNull(killer.y), numberOrNull(kill.victim_stamina_5s), numberOrNull(kill.victim_stamina_5s_limit), kill.parser_version
    ]);
  }

  async persistDailySummary(client, day, sourceSnapshotId) {
    const quotas = [...this.engine.dailyQuota.values()].filter(row => row.local_date === day);
    const stats = [...this.engine.dailyStats.values()].filter(row => row.local_date === day);
    const byUser = new Map();
    for (const row of quotas) byUser.set(String(row.user_id), { ...row });
    for (const row of stats) byUser.set(String(row.user_id), { ...(byUser.get(String(row.user_id)) || {}), ...row });
    const ranked = quotas.filter(row => row.closing_quota !== null && row.closing_quota !== undefined).sort((a, b) => Number(b.closing_quota) - Number(a.closing_quota) || Number(a.user_id) - Number(b.user_id));
    const topIds = new Set(ranked.slice(0, CANDIDATE_LIMIT).map(row => String(row.user_id)));
    for (const [uid, row] of byUser) {
      const income = row.income === undefined ? null : row.income;
      const kills = Number(row.kills || 0);
      const deaths = Number(row.deaths || 0);
      const hasQuota = quotas.some(q => String(q.user_id) === uid);
      const keep = kills !== 0 || deaths !== 0 || income === null && hasQuota || income !== null && income !== 0 || topIds.has(uid);
      if (!keep) continue;
      const q = quotas.find(item => String(item.user_id) === uid) || {};
      const status = !hasQuota ? 'absent' : income === null ? 'unknown' : 'known';
      await client.query(`INSERT INTO panel_daily_summary (local_date,user_id,kills,deaths,initial_quota,closing_quota,income,quota_status,quota_top_candidate,source_snapshot_id,updated_at)
        VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
        ON CONFLICT (local_date,user_id) DO UPDATE SET kills=EXCLUDED.kills,deaths=EXCLUDED.deaths,initial_quota=COALESCE(panel_daily_summary.initial_quota,EXCLUDED.initial_quota),closing_quota=EXCLUDED.closing_quota,income=EXCLUDED.income,quota_status=EXCLUDED.quota_status,quota_top_candidate=EXCLUDED.quota_top_candidate,source_snapshot_id=EXCLUDED.source_snapshot_id,updated_at=now()`, [
        day, Number(uid), kills, deaths, q.initial_quota ?? null, q.closing_quota ?? null, income, status, topIds.has(uid), sourceSnapshotId
      ]);
    }
  }

  async persistResult(client, result) {
    const { parsed, version } = result;
    for (const entity of parsed.entities) {
      const state = this.engine.currentStates.get(String(entity.user_id));
      await this.upsertCurrent(client, entity, parsed, version, state, true);
    }
    if (parsed.completeness === 'steady') {
      for (const userId of this.engine.lastClosedUsers || []) await client.query('UPDATE panel_player_current SET online=false, updated_at=now() WHERE user_id=$1', [userId]);
    }
    for (const message of this.engine.messages.values()) if (message.last_observed_snapshot_id === parsed.snapshotId) await this.upsertMessage(client, message);
    for (const kill of this.engine.lastTouchedKills || []) await this.upsertKill(client, kill);
    await this.persistDailySummary(client, parsed.serverDay, parsed.snapshotId);
    const map = loadMapMetadata();
    if (map) await client.query(`INSERT INTO panel_map_metadata (map_id,version,payload,updated_at) VALUES ($1,$2,$3::jsonb,now()) ON CONFLICT (map_id,version) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`, [map.id, map.version, JSON.stringify(map)]);
  }

  async applyObservation(body, metadata = {}) {
    const result = this.engine.applyObservation(body, metadata);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (result.version) await this.upsertVersion(client, result.version, result.parsed);
      if (result.status === 'projected' || result.status === 'warming_up') await this.persistResult(client, result);
      await client.query('COMMIT');
      compactEngine(this.engine);
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      try { await this.hydrate(); } catch (_) { /* preserve write failure */ }
      throw error;
    } finally { client.release(); }
  }

  async getRealtimeResource(resource, versionToken = null) {
    const latest = await this.getLatestVersion();
    if (!latest) {
      const empty = { unchanged: false, versionToken: null, latest: null, serverDay: null };
      if (resource === 'chat') empty.messages = [];
      if (resource === 'map') { empty.map = this.engine.mapMetadata; empty.players = []; }
      if (resource === 'players') empty.players = [];
      if (resource === 'kills') empty.kills = [];
      return empty;
    }
    if (versionToken && versionToken === latest.version_token) return { unchanged: true, versionToken: latest.version_token };
    const day = String(latest.server_day).slice(0, 10);
    const common = { versionToken: latest.version_token, latest, serverDay: day };
    if (resource === 'chat') {
      const result = await this.query(`SELECT ${MESSAGE_COLUMNS} FROM panel_message_events WHERE server_day=$1::date ORDER BY event_at,message_id`, [day]);
      return { ...common, messages: result.rows };
    }
    if (resource === 'kills') {
      const result = await this.query(`SELECT ${KILL_COLUMNS} ${KILL_FROM} WHERE ke.local_date=$1::date ORDER BY ke.event_at,ke.local_date,ke.kill_id`, [day]);
      return { ...common, kills: result.rows };
    }
    if (resource === 'map') {
      const [players, map] = await Promise.all([
        this.query(`SELECT ${currentColumns('pc')} FROM panel_player_current pc WHERE pc.server_day=$1::date AND pc.online=true AND (pc.death_drop_coins >= 1 OR (pc.stamina_1d IS NOT NULL AND pc.stamina_1d_limit IS NOT NULL AND pc.stamina_1d < pc.stamina_1d_limit))`, [day]),
        this.query('SELECT payload FROM panel_map_metadata ORDER BY updated_at DESC LIMIT 1')
      ]);
      return { ...common, map: map.rows[0]?.payload || this.engine.mapMetadata, players: players.rows.map(row => rowToPlayer(row, { kills: row.kills, deaths: row.deaths }, { currentDay: day })).map(player => ({ userId: player.userId, name: player.name, online: player.online, drop: player.drop, state: player.state ? { hp: player.state.hp, maxHp: player.state.maxHp, x: player.state.x, y: player.state.y, invulnerableRemainingSecs: player.state.invulnerableRemainingSecs, loss: player.state.loss, stamina5s: player.state.stamina5s, stamina1h: player.state.stamina1h, stamina1d: player.state.stamina1d, stamina5sLimit: player.state.stamina5sLimit, stamina1hLimit: player.state.stamina1hLimit, stamina1dLimit: player.state.stamina1dLimit } : null })) };
    }
    if (resource === 'players') {
      const result = await this.query(`WITH ranked AS (
          SELECT pc.*, NULLIF(pc.external_balance_snapshot, 0) AS balance_rank,
            (SELECT count(*) FROM panel_kill_events ke WHERE ke.local_date=$1::date AND ke.killer_user_id=pc.user_id) AS live_kills,
            (SELECT COALESCE(sum(1),0) FROM panel_kill_events ke WHERE ke.local_date=$1::date AND ke.victim_user_id=pc.user_id) AS live_deaths
          FROM panel_player_current pc
        ), quota_top AS (SELECT user_id FROM ranked WHERE balance_rank IS NOT NULL ORDER BY balance_rank DESC,user_id LIMIT 50),
        drop_top AS (SELECT user_id FROM ranked WHERE server_day=$1::date AND death_drop_coins IS NOT NULL ORDER BY death_drop_coins DESC,user_id LIMIT 50),
        income_top AS (SELECT user_id FROM ranked WHERE today_income IS NOT NULL ORDER BY today_income DESC,user_id LIMIT 50),
        candidates AS (SELECT user_id FROM quota_top UNION SELECT user_id FROM drop_top UNION SELECT user_id FROM income_top)
        SELECT ${currentColumns('r').replace(/r\.today_kills AS kills, r\.today_deaths AS deaths/, 'r.live_kills AS kills, r.live_deaths AS deaths')}
        FROM ranked r INNER JOIN candidates c USING (user_id) ORDER BY r.user_id LIMIT 5001`, [day]);
      return { ...common, players: result.rows.map(row => rowToPlayer(row, { kills: row.kills, deaths: row.deaths }, { currentDay: day, lastKnownBalance: true })) };
    }
    throw new Error(`unknown realtime resource: ${resource}`);
  }

  async getRealtime(versionToken = null) {
    const [players, messages, kills] = await Promise.all([this.getRealtimePlayers(versionToken), this.getRealtimeChat(versionToken), this.getRealtimeKills(versionToken)]);
    if (players.unchanged) return players;
    return { ...players, messages: messages.messages, kills: kills.kills, map: (await this.getRealtimeMap(versionToken)).map };
  }
  async getRealtimeChat(token) { return this.getRealtimeResource('chat', token); }
  async getRealtimeMap(token) { return this.getRealtimeResource('map', token); }
  async getRealtimePlayers(token) { return this.getRealtimeResource('players', token); }
  async getRealtimeKills(token) { return this.getRealtimeResource('kills', token); }

  async getHistoryResource(resource, range, _latest = null, rowCap = null) {
    const limit = rowCap || (resource === 'chat' ? HISTORY_ROW_LIMITS.messages : resource === 'kills' ? HISTORY_ROW_LIMITS.kills : HISTORY_ROW_LIMITS.players);
    if (resource === 'chat') {
      const result = await this.query(`SELECT ${MESSAGE_COLUMNS} FROM panel_message_events WHERE server_day BETWEEN $1::date AND $2::date ORDER BY event_at,server_day,message_id LIMIT $3`, [range.from, range.to, limit + 1]);
      if (result.rows.length > limit) throw Object.assign(new Error('history messages result exceeds limit'), { code: 'history_result_limit', resource: 'messages', limit });
      return { from: range.from, to: range.to, messages: result.rows, closedThrough: range.to };
    }
    if (resource === 'kills') {
      const result = await this.query(`SELECT ${KILL_COLUMNS} ${KILL_FROM} WHERE ke.local_date BETWEEN $1::date AND $2::date ORDER BY ke.event_at,ke.local_date,ke.kill_id LIMIT $3`, [range.from, range.to, limit + 1]);
      if (result.rows.length > limit) throw Object.assign(new Error('history kills result exceeds limit'), { code: 'history_result_limit', resource: 'kills', limit });
      return { from: range.from, to: range.to, kills: result.rows, closedThrough: range.to };
    }
    if (resource === 'players') {
      const latest = _latest || await this.getLatestVersion();
      const latestDay = latest?.server_day ? String(latest.server_day).slice(0, 10) : range.to;
      const result = await this.query(`WITH agg AS (
          SELECT user_id,
            min(initial_quota) FILTER (WHERE initial_quota IS NOT NULL) AS initial_quota,
            (array_agg(closing_quota ORDER BY local_date DESC) FILTER (WHERE closing_quota IS NOT NULL))[1] AS quota_value,
            CASE WHEN bool_or(quota_status='unknown') THEN NULL ELSE sum(income) FILTER (WHERE quota_status='known') END AS income,
            sum(kills)::int AS kills, sum(deaths)::int AS deaths,
            bool_or(quota_status <> 'absent') AS has_quota
          FROM panel_daily_summary WHERE local_date BETWEEN $1::date AND $2::date GROUP BY user_id
        ), rows AS (
          SELECT pc.*, a.user_id AS aggregate_user_id,
            a.initial_quota AS range_initial_quota, a.quota_value AS range_quota_value,
            a.income AS range_income, a.kills AS range_kills, a.deaths AS range_deaths,
            CASE WHEN a.user_id IS NULL THEN NULL ELSE $1::text END AS range_quota_day,
            CASE WHEN pc.server_day=$3::date THEN pc.death_drop_coins ELSE NULL END AS current_drop
          FROM panel_player_current pc LEFT JOIN agg a USING(user_id)
        ), quota_top AS (SELECT user_id FROM rows WHERE range_quota_value IS NOT NULL ORDER BY range_quota_value DESC,user_id LIMIT 50),
        -- Zero income is the absence of a change, not a useful ranking fact.
        -- The compact summary intentionally omits those rows; retaining them
        -- here would reintroduce arbitrary low-user-id candidates when all
        -- values tie at zero.
        income_top AS (SELECT user_id FROM rows WHERE range_income IS NOT NULL AND range_income <> 0 ORDER BY range_income DESC,user_id LIMIT 50),
        drop_top AS (SELECT user_id FROM rows WHERE current_drop IS NOT NULL ORDER BY current_drop DESC,user_id LIMIT 50),
        candidates AS (SELECT user_id FROM quota_top UNION SELECT user_id FROM income_top UNION SELECT user_id FROM drop_top)
        SELECT r.user_id, r.current_name, r.last_seen_at, r.current_entity_id, r.online, r.server_day,
          r.state_snapshot_id AS snapshot_id, r.state_observed_at AS observed_at, r.reset_generation,
          ${stateJson('r')} AS state, r.range_quota_day AS quota_day,
          r.range_initial_quota AS initial_quota, r.range_quota_value AS quota_value,
          r.range_income AS income, r.range_kills AS kills, r.range_deaths AS deaths
        FROM rows r INNER JOIN candidates c USING(user_id) ORDER BY r.user_id LIMIT 5001`, [range.from, range.to, latestDay]);
      if (result.rows.length > limit) throw Object.assign(new Error('history players result exceeds limit'), { code: 'history_result_limit', resource: 'players', limit });
      return { from: range.from, to: range.to, players: result.rows.map(row => rowToPlayer(row, { kills: row.kills, deaths: row.deaths }, { currentDay: latestDay })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-u-co-pinyin') || a.userId - b.userId), closedThrough: latestDay > range.to ? range.to : null };
    }
    throw new Error(`unknown history resource: ${resource}`);
  }

  async getHistory(range) {
    const latest = await this.getLatestVersion();
    const [chat, kills, players, summary] = await Promise.all([
      this.getHistoryResource('chat', range, latest), this.getHistoryResource('kills', range, latest), this.getHistoryResource('players', range, latest),
      this.query(`SELECT local_date::text,user_id,kills,deaths,initial_quota,closing_quota,income,finalized_at FROM panel_daily_summary WHERE local_date BETWEEN $1::date AND $2::date ORDER BY local_date,user_id`, [range.from, range.to])
    ]);
    return { from: range.from, to: range.to, timezone: BUSINESS_TIMEZONE, generatedAt: new Date().toISOString(), closedThrough: latest?.server_day && range.to < String(latest.server_day).slice(0, 10) ? range.to : null, players: players.players, messages: chat.messages, kills: kills.kills, dailyQuota: summary.rows.filter(row => row.income !== null || row.initial_quota !== null).map(row => ({ local_date: String(row.local_date).slice(0, 10), user_id: Number(row.user_id), initial_quota: numberOrNull(row.initial_quota), closing_quota: numberOrNull(row.closing_quota), income: numberOrNull(row.income), finalized_at: row.finalized_at })), stats: summary.rows.filter(row => Number(row.kills) || Number(row.deaths)).map(row => ({ local_date: String(row.local_date).slice(0, 10), user_id: Number(row.user_id), kills: Number(row.kills), deaths: Number(row.deaths) })) };
  }
  async getHistoryChat(range, latest, rowCap) { return this.getHistoryResource('chat', range, latest, rowCap); }
  async getHistoryPlayers(range, latest) { return this.getHistoryResource('players', range, latest); }
  async getHistoryKills(range, latest, rowCap) { return this.getHistoryResource('kills', range, latest, rowCap); }
}

module.exports = { CompactPostgresPanelStore };
