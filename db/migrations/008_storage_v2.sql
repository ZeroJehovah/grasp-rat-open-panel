-- Compact storage model for the panel.  The collector keeps the raw response
-- queue for short replay; PostgreSQL keeps only current player facts, daily
-- aggregates, page events, and a small version/deduplication index.

CREATE TABLE IF NOT EXISTS panel_player_current (
  user_id bigint PRIMARY KEY,
  current_name text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  current_entity_id bigint,
  online boolean NOT NULL DEFAULT false,
  server_day date,
  state_snapshot_id text,
  state_observed_at timestamptz,
  reset_generation integer,
  x double precision,
  y double precision,
  hp double precision,
  max_hp double precision,
  invulnerable_remaining_secs double precision,
  stamina_5s double precision,
  stamina_5s_limit double precision,
  stamina_1h double precision,
  stamina_1h_limit double precision,
  stamina_1d double precision,
  stamina_1d_limit double precision,
  current_join_mode text,
  life text,
  death_drop_coins numeric,
  death_loss_preview numeric,
  external_balance_snapshot numeric,
  quota_day date,
  initial_quota numeric,
  quota_value numeric,
  quota_source text,
  today_kills integer NOT NULL DEFAULT 0,
  today_deaths integer NOT NULL DEFAULT 0,
  today_income numeric,
  today_quota_known boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS panel_player_current_quota_idx
  ON panel_player_current (quota_value DESC NULLS LAST, user_id);
CREATE INDEX IF NOT EXISTS panel_player_current_drop_idx
  ON panel_player_current (death_drop_coins DESC NULLS LAST, user_id);
CREATE INDEX IF NOT EXISTS panel_player_current_day_idx
  ON panel_player_current (server_day, online, user_id);

CREATE TABLE IF NOT EXISTS panel_daily_summary (
  local_date date NOT NULL,
  user_id bigint NOT NULL,
  kills integer NOT NULL DEFAULT 0,
  deaths integer NOT NULL DEFAULT 0,
  initial_quota numeric,
  closing_quota numeric,
  income numeric,
  quota_status text NOT NULL DEFAULT 'absent'
    CHECK (quota_status IN ('known', 'unknown', 'absent')),
  quota_top_candidate boolean NOT NULL DEFAULT false,
  finalized_at timestamptz,
  source_snapshot_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (local_date, user_id)
);

CREATE INDEX IF NOT EXISTS panel_daily_summary_user_date_idx
  ON panel_daily_summary (user_id, local_date);
CREATE INDEX IF NOT EXISTS panel_daily_summary_date_idx
  ON panel_daily_summary (local_date, user_id);

CREATE TABLE IF NOT EXISTS panel_message_events (
  server_day date NOT NULL,
  message_id bigint NOT NULL,
  tick bigint NOT NULL,
  kind text NOT NULL,
  text text NOT NULL,
  user_id bigint,
  target_user_id bigint,
  user_name text,
  target_name text,
  event_at timestamptz NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  PRIMARY KEY (server_day, message_id)
);

CREATE INDEX IF NOT EXISTS panel_message_events_day_time_idx
  ON panel_message_events (server_day, event_at, message_id);

CREATE TABLE IF NOT EXISTS panel_kill_events (
  local_date date NOT NULL,
  kill_id text NOT NULL,
  message_id text NOT NULL,
  event_at timestamptz NOT NULL,
  server_day date NOT NULL,
  tick bigint NOT NULL,
  killer_user_id bigint,
  victim_user_id bigint,
  killer_name text,
  victim_name text,
  confidence text NOT NULL CHECK (confidence IN ('confirmed', 'inferred', 'unknown')),
  drop_amount numeric,
  drop_confidence text,
  victim_x double precision,
  victim_y double precision,
  killer_x double precision,
  killer_y double precision,
  victim_stamina_5s double precision,
  victim_stamina_5s_limit double precision,
  parser_version text NOT NULL,
  PRIMARY KEY (local_date, kill_id)
);

CREATE INDEX IF NOT EXISTS panel_kill_events_date_time_idx
  ON panel_kill_events (local_date, event_at, kill_id);
CREATE INDEX IF NOT EXISTS panel_kill_events_players_idx
  ON panel_kill_events (killer_user_id, victim_user_id, local_date);

CREATE TABLE IF NOT EXISTS panel_version_dedupe (
  snapshot_id text PRIMARY KEY,
  snapshot_key text NOT NULL UNIQUE,
  version_token text NOT NULL UNIQUE,
  server_day date NOT NULL,
  reset_generation integer NOT NULL,
  server_tick bigint NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  entity_count integer NOT NULL,
  total_entities integer,
  bullet_count integer,
  coin_drop_count integer,
  message_count integer,
  payload_hash char(64) NOT NULL,
  completeness text NOT NULL CHECK (completeness IN ('steady', 'warming_up')),
  schema_version text NOT NULL,
  duplicate_poll_count integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS panel_version_dedupe_observed_idx
  ON panel_version_dedupe (observed_at DESC);
CREATE INDEX IF NOT EXISTS panel_version_dedupe_day_idx
  ON panel_version_dedupe (server_day, observed_at DESC);

CREATE TABLE IF NOT EXISTS panel_day_status (
  server_day date PRIMARY KEY,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  version_count integer NOT NULL DEFAULT 0,
  latest_version_token text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS panel_map_metadata (
  map_id text NOT NULL,
  version integer NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (map_id, version)
);

CREATE TABLE IF NOT EXISTS panel_storage_migration (
  migration_id text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS panel_retention_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  boundary_date date NOT NULL,
  rows_affected bigint NOT NULL DEFAULT 0,
  completed_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
