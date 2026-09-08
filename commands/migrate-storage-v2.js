#!/usr/bin/env node
'use strict';

const { Client } = require('pg');

const OLD_TABLES = [
  'player_state_base',
  'player_state_delta',
  'player_online_interval',
  'player_entity_history',
  'coin_drop_lifecycles',
  'player_daily_stats',
  'player_daily_quota',
  'player_quota_adjustments',
  'player_quota_current',
  'player_state_current',
  'player_name_history',
  'message_events',
  'kill_events',
  'snapshot_observations',
  'snapshot_versions',
  'players',
  'map_metadata',
  'retention_audit'
];

function hasFlag(name) { return process.argv.slice(2).includes(name); }

function compactOnlyValidation(counts) {
  if (!counts.panel_player_current || !counts.panel_version_dedupe || !counts.panel_day_status) {
    throw new Error(`storage v2 compact validation failed: ${JSON.stringify(counts)}`);
  }
  return { compactTablesPresent: true, counts };
}

async function count(client, table) {
  const result = await client.query(`SELECT count(*)::bigint AS count FROM ${table}`);
  return Number(result.rows[0].count);
}

async function backfill(client) {
  await client.query('TRUNCATE panel_player_current, panel_daily_summary, panel_message_events, panel_kill_events, panel_version_dedupe, panel_day_status, panel_map_metadata');

  await client.query(`
    INSERT INTO panel_player_current (
      user_id, current_name, first_seen_at, last_seen_at, current_entity_id, online,
      server_day, state_snapshot_id, state_observed_at, reset_generation,
      x, y, hp, max_hp, invulnerable_remaining_secs,
      stamina_5s, stamina_5s_limit, stamina_1h, stamina_1h_limit,
      stamina_1d, stamina_1d_limit, current_join_mode, life,
      death_drop_coins, death_loss_preview, external_balance_snapshot,
      quota_day, initial_quota, quota_value, quota_source,
      today_kills, today_deaths, today_income, today_quota_known, updated_at
    )
    SELECT p.user_id, p.current_name, p.first_seen_at, p.last_seen_at,
      p.current_entity_id, p.online,
      c.server_day, c.snapshot_id, c.observed_at, c.reset_generation,
      NULLIF(c.state->>'x', '')::double precision,
      NULLIF(c.state->>'y', '')::double precision,
      NULLIF(c.state->>'hp', '')::double precision,
      NULLIF(c.state->>'max_hp', '')::double precision,
      NULLIF(c.state->>'invulnerable_remaining_secs', '')::double precision,
      NULLIF(c.state->>'stamina_5s_remaining_milli', '')::double precision,
      NULLIF(c.state->>'stamina_5s_limit_milli', '')::double precision,
      NULLIF(c.state->>'stamina_1h_remaining_milli', '')::double precision,
      NULLIF(c.state->>'stamina_1h_limit_milli', '')::double precision,
      NULLIF(c.state->>'stamina_1d_remaining_milli', '')::double precision,
      NULLIF(c.state->>'stamina_1d_limit_milli', '')::double precision,
      c.state->>'current_join_mode', c.state->>'life',
      NULLIF(c.state->>'death_drop_coins', '')::numeric,
      NULLIF(c.state->>'death_loss_preview', '')::numeric,
      NULLIF(c.state->>'external_balance_snapshot', '')::numeric,
      q.quota_day, q.initial_quota, q.quota_value, q.quota_source,
      COALESCE(s.kills, 0), COALESCE(s.deaths, 0), d.income,
      CASE WHEN d.user_id IS NULL THEN NULL ELSE d.income IS NOT NULL END,
      now()
    FROM players p
    LEFT JOIN player_state_current c ON c.user_id = p.user_id
    LEFT JOIN player_quota_current q ON q.user_id = p.user_id
    LEFT JOIN LATERAL (
      SELECT max(server_day) AS day FROM snapshot_versions
    ) latest ON true
    LEFT JOIN player_daily_stats s ON s.user_id = p.user_id AND s.local_date = latest.day
    LEFT JOIN player_daily_quota d ON d.user_id = p.user_id AND d.local_date = latest.day
  `);

  await client.query(`
    WITH quota_ranked AS (
      SELECT q.local_date, q.user_id,
        row_number() OVER (PARTITION BY q.local_date ORDER BY q.closing_quota DESC NULLS LAST, q.user_id) AS quota_rank
      FROM player_daily_quota q
      WHERE q.closing_quota IS NOT NULL
    ), candidates AS (
      SELECT COALESCE(s.local_date, q.local_date) AS local_date,
             COALESCE(s.user_id, q.user_id) AS user_id,
             COALESCE(s.kills, 0) AS kills,
             COALESCE(s.deaths, 0) AS deaths,
             q.initial_quota, q.closing_quota, q.income,
             CASE WHEN q.user_id IS NULL THEN 'absent'
                  WHEN q.income IS NULL THEN 'unknown' ELSE 'known' END AS quota_status,
             COALESCE(r.quota_rank <= 50, false) AS quota_top_candidate,
             q.finalized_at, q.source_snapshot_id
      FROM player_daily_stats s
      FULL JOIN player_daily_quota q USING (local_date, user_id)
      LEFT JOIN quota_ranked r USING (local_date, user_id)
    )
    INSERT INTO panel_daily_summary (
      local_date, user_id, kills, deaths, initial_quota, closing_quota,
      income, quota_status, quota_top_candidate, finalized_at, source_snapshot_id
    )
    SELECT local_date, user_id, kills, deaths, initial_quota, closing_quota,
      income, quota_status, quota_top_candidate, finalized_at, source_snapshot_id
    FROM candidates
    WHERE kills <> 0 OR deaths <> 0 OR income IS NULL OR income <> 0 OR quota_top_candidate
  `);

  await client.query(`
    INSERT INTO panel_message_events (
      server_day, message_id, tick, kind, text, user_id, target_user_id,
      user_name, target_name, event_at, first_observed_at, last_observed_at
    )
    SELECT server_day, message_id, tick, kind, text, user_id, target_user_id,
      user_name, target_name, event_at, first_observed_at, last_observed_at
    FROM message_events
  `);

  await client.query(`
    INSERT INTO panel_kill_events (
      local_date, kill_id, message_id, event_at, server_day, tick,
      killer_user_id, victim_user_id, killer_name, victim_name, confidence,
      drop_amount, drop_confidence, victim_x, victim_y, killer_x, killer_y,
      victim_stamina_5s, victim_stamina_5s_limit, parser_version
    )
    SELECT local_date, kill_id, message_id, event_at, server_day, tick,
      killer_user_id, victim_user_id, killer_name, victim_name, confidence,
      NULLIF(drop->>'amount', '')::numeric,
      drop->>'confidence',
      NULLIF(victim_position->>'x', '')::double precision,
      NULLIF(victim_position->>'y', '')::double precision,
      NULLIF(killer_position->>'x', '')::double precision,
      NULLIF(killer_position->>'y', '')::double precision,
      victim_stamina_5s, victim_stamina_5s_limit, parser_version
    FROM kill_events
  `);

  await client.query(`
    INSERT INTO panel_version_dedupe (
      snapshot_id, snapshot_key, version_token, server_day, reset_generation,
      server_tick, observed_at, received_at, entity_count, total_entities,
      bullet_count, coin_drop_count, message_count, payload_hash,
      completeness, schema_version, duplicate_poll_count
    )
    SELECT snapshot_id,
      server_day::text || '/' || reset_generation::text || '/' || server_tick::text || '/' || payload_hash,
      COALESCE(version_token, snapshot_id), server_day, reset_generation,
      server_tick, observed_at, received_at, entity_count, total_entities,
      bullet_count, coin_drop_count, message_count, payload_hash,
      completeness, schema_version, duplicate_poll_count
    FROM snapshot_versions
    WHERE completeness IN ('steady', 'warming_up')
  `);

  await client.query(`
    INSERT INTO panel_day_status (server_day, first_observed_at, last_observed_at, version_count, latest_version_token)
    SELECT server_day, min(observed_at), max(observed_at), count(*)::int,
      (array_agg(version_token ORDER BY observed_at DESC))[1]
    FROM panel_version_dedupe
    GROUP BY server_day
  `);

  await client.query(`
    INSERT INTO panel_map_metadata (map_id, version, payload, updated_at)
    SELECT map_id, version, payload, updated_at FROM map_metadata
  `);

  const result = {};
  for (const table of ['panel_player_current', 'panel_daily_summary', 'panel_message_events', 'panel_kill_events', 'panel_version_dedupe', 'panel_day_status']) result[table] = await count(client, table);
  return result;
}

async function validate(client, counts) {
  const checks = {};
  checks.players = Number((await client.query('SELECT count(*)::bigint AS count FROM players')).rows[0].count);
  checks.newPlayers = counts.panel_player_current;
  checks.kills = Number((await client.query('SELECT count(*)::bigint AS count FROM kill_events')).rows[0].count);
  checks.newKills = counts.panel_kill_events;
  checks.messages = Number((await client.query('SELECT count(*)::bigint AS count FROM message_events')).rows[0].count);
  checks.newMessages = counts.panel_message_events;
  checks.oldDailyStats = Number((await client.query('SELECT count(*)::bigint AS count FROM player_daily_stats')).rows[0].count);
  checks.oldDailyQuota = Number((await client.query('SELECT count(*)::bigint AS count FROM player_daily_quota')).rows[0].count);
  checks.newSummary = counts.panel_daily_summary;
  checks.oldDailyKills = Number((await client.query('SELECT COALESCE(sum(kills), 0)::bigint AS count FROM player_daily_stats')).rows[0].count);
  checks.newDailyKills = Number((await client.query('SELECT COALESCE(sum(kills), 0)::bigint AS count FROM panel_daily_summary')).rows[0].count);
  checks.oldDailyDeaths = Number((await client.query('SELECT COALESCE(sum(deaths), 0)::bigint AS count FROM player_daily_stats')).rows[0].count);
  checks.newDailyDeaths = Number((await client.query('SELECT COALESCE(sum(deaths), 0)::bigint AS count FROM panel_daily_summary')).rows[0].count);
  checks.oldDailyIncome = (await client.query('SELECT COALESCE(sum(income), 0)::numeric AS value FROM player_daily_quota')).rows[0].value;
  checks.newDailyIncome = (await client.query("SELECT COALESCE(sum(income), 0)::numeric AS value FROM panel_daily_summary WHERE quota_status = 'known'")).rows[0].value;
  if (checks.players !== checks.newPlayers || checks.kills !== checks.newKills || checks.messages !== checks.newMessages || checks.oldDailyKills !== checks.newDailyKills || checks.oldDailyDeaths !== checks.newDailyDeaths) {
    throw new Error(`storage v2 validation failed: ${JSON.stringify(checks)}`);
  }
  return checks;
}

async function dropOldTables(client) {
  for (const table of OLD_TABLES) await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  await client.query('DROP FUNCTION IF EXISTS ensure_panel_date_partitions(date) CASCADE');
  await client.query('DROP FUNCTION IF EXISTS prune_panel_date_partitions(date) CASCADE');
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const skipBackfill = hasFlag('--skip-backfill');
    const dropOld = hasFlag('--drop-old');
    const previous = await client.query("SELECT detail FROM panel_storage_migration WHERE migration_id = 'storage-v2' FOR UPDATE");
    const previousDetail = previous.rows[0]?.detail || {};
    if (previousDetail.oldTablesDropped === true && !skipBackfill) {
      throw new Error('storage-v2 old tables are already dropped; use --skip-backfill for an idempotent validation');
    }
    let counts;
    let checks;
    if (skipBackfill) {
      counts = {};
      for (const table of ['panel_player_current', 'panel_daily_summary', 'panel_message_events', 'panel_kill_events', 'panel_version_dedupe', 'panel_day_status']) counts[table] = await count(client, table);
      checks = compactOnlyValidation(counts);
    } else {
      counts = await backfill(client);
      checks = await validate(client, counts);
    }
    if (dropOld) await dropOldTables(client);
    const oldTablesDropped = dropOld || previousDetail.oldTablesDropped === true;
    await client.query(`INSERT INTO panel_storage_migration (migration_id, detail) VALUES ('storage-v2', $1::jsonb) ON CONFLICT (migration_id) DO UPDATE SET completed_at = now(), detail = EXCLUDED.detail`, [JSON.stringify({ counts, checks, oldTablesDropped, skipBackfill })]);
    await client.query('COMMIT');
    console.log(JSON.stringify({ type: 'storage-v2-migration', counts, checks, oldTablesDropped, skipBackfill }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
