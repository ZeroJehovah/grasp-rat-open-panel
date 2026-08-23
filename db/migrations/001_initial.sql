-- Grasp Rat Open Panel structured facts schema.
-- The collector never writes credentials or raw response bodies to PostgreSQL.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS snapshot_observations (
  observation_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status_code integer,
  duration_ms integer,
  body_bytes bigint,
  payload_hash char(64),
  raw_path text,
  egress_id text,
  egress_group text CHECK (egress_group IS NULL OR egress_group IN ('A', 'B')),
  retry_no integer NOT NULL DEFAULT 0 CHECK (retry_no >= 0),
  error text,
  schema_version text,
  parse_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS snapshot_observations_observed_at_idx ON snapshot_observations (observed_at DESC);
CREATE INDEX IF NOT EXISTS snapshot_observations_payload_hash_idx ON snapshot_observations (payload_hash);

CREATE TABLE IF NOT EXISTS snapshot_versions (
  snapshot_id text PRIMARY KEY,
  version_token text NOT NULL,
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
  completeness text NOT NULL CHECK (completeness IN ('steady', 'warming_up', 'invalid')),
  schema_version text NOT NULL,
  duplicate_poll_count integer NOT NULL DEFAULT 0,
  observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (server_day, reset_generation, server_tick, payload_hash),
  UNIQUE (version_token)
);

CREATE INDEX IF NOT EXISTS snapshot_versions_steady_time_idx ON snapshot_versions (server_day, observed_at DESC) WHERE completeness = 'steady';

CREATE TABLE IF NOT EXISTS players (
  user_id bigint PRIMARY KEY,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  current_name text NOT NULL DEFAULT '',
  current_entity_id bigint,
  online boolean NOT NULL DEFAULT false,
  last_snapshot_id text REFERENCES snapshot_versions(snapshot_id),
  segment_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_name_history (
  user_id bigint NOT NULL REFERENCES players(user_id),
  name text NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE IF NOT EXISTS player_entity_history (
  user_id bigint NOT NULL REFERENCES players(user_id),
  entity_id bigint NOT NULL,
  reset_generation integer NOT NULL,
  first_snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  last_snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, entity_id, reset_generation)
);

CREATE TABLE IF NOT EXISTS player_state_base (
  snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  user_id bigint NOT NULL REFERENCES players(user_id),
  segment_id text NOT NULL,
  schema_version text NOT NULL,
  state jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (snapshot_id, user_id, segment_id)
);

CREATE TABLE IF NOT EXISTS player_state_delta (
  snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  user_id bigint NOT NULL REFERENCES players(user_id),
  segment_id text NOT NULL,
  changed_mask jsonb NOT NULL,
  changed_values jsonb NOT NULL,
  missing_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (snapshot_id, user_id, segment_id)
);

CREATE INDEX IF NOT EXISTS player_state_delta_user_time_idx ON player_state_delta (user_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS player_state_current (
  user_id bigint PRIMARY KEY REFERENCES players(user_id),
  entity_id bigint,
  segment_id text NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  server_day date NOT NULL,
  reset_generation integer NOT NULL,
  online boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS player_state_current_rank_idx ON player_state_current ((NULLIF(state->>'death_drop_coins', '')::numeric) DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS player_state_current_online_idx ON player_state_current (server_day, online);

CREATE TABLE IF NOT EXISTS player_online_interval (
  interval_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES players(user_id),
  segment_id text NOT NULL,
  server_day date NOT NULL,
  online_from_snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  online_to_snapshot_id text REFERENCES snapshot_versions(snapshot_id),
  online_from_at timestamptz NOT NULL,
  online_to_at timestamptz,
  closed_reason text
);

CREATE INDEX IF NOT EXISTS player_online_interval_user_time_idx ON player_online_interval (user_id, online_from_at DESC);

CREATE TABLE IF NOT EXISTS message_events (
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
  first_observed_snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  last_observed_snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  PRIMARY KEY (server_day, message_id)
) PARTITION BY RANGE (server_day);

CREATE TABLE IF NOT EXISTS message_events_default PARTITION OF message_events DEFAULT;
CREATE INDEX IF NOT EXISTS message_events_date_idx ON message_events (server_day, event_at);

CREATE TABLE IF NOT EXISTS kill_events (
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
  kind text NOT NULL DEFAULT 'kill',
  confidence text NOT NULL CHECK (confidence IN ('confirmed', 'inferred', 'unknown')),
  evidence_snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  drop jsonb,
  victim_position jsonb,
  killer_position jsonb,
  victim_stamina_5s numeric,
  victim_stamina_5s_limit numeric,
  parser_version text NOT NULL,
  PRIMARY KEY (local_date, kill_id)
) PARTITION BY RANGE (local_date);

CREATE TABLE IF NOT EXISTS kill_events_default PARTITION OF kill_events DEFAULT;
CREATE INDEX IF NOT EXISTS kill_events_date_time_idx ON kill_events (local_date, event_at);
CREATE INDEX IF NOT EXISTS kill_events_players_idx ON kill_events (killer_user_id, victim_user_id, local_date);

CREATE TABLE IF NOT EXISTS coin_drop_lifecycles (
  server_day date NOT NULL,
  drop_id bigint NOT NULL,
  first_seen_snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  last_seen_snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  disappeared_at timestamptz,
  source_user_id bigint,
  system_spawned boolean NOT NULL,
  x numeric,
  y numeric,
  amount numeric,
  created_tick bigint,
  source text NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('confirmed', 'inferred', 'unknown')),
  kill_event_id text,
  PRIMARY KEY (server_day, drop_id)
) PARTITION BY RANGE (server_day);

CREATE TABLE IF NOT EXISTS coin_drop_lifecycles_default PARTITION OF coin_drop_lifecycles DEFAULT;
CREATE INDEX IF NOT EXISTS coin_drop_date_idx ON coin_drop_lifecycles (server_day, created_tick);

CREATE TABLE IF NOT EXISTS player_daily_stats (
  local_date date NOT NULL,
  user_id bigint NOT NULL REFERENCES players(user_id),
  kills integer NOT NULL DEFAULT 0,
  deaths integer NOT NULL DEFAULT 0,
  PRIMARY KEY (local_date, user_id)
) PARTITION BY RANGE (local_date);

CREATE TABLE IF NOT EXISTS player_daily_stats_default PARTITION OF player_daily_stats DEFAULT;

CREATE TABLE IF NOT EXISTS player_quota_current (
  user_id bigint PRIMARY KEY REFERENCES players(user_id),
  quota_day date NOT NULL,
  initial_quota numeric,
  quota_value numeric,
  last_drop numeric,
  last_loss numeric,
  last_snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS player_quota_current_value_idx ON player_quota_current (quota_value DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS player_quota_adjustments (
  adjustment_id bigint GENERATED ALWAYS AS IDENTITY,
  user_id bigint NOT NULL REFERENCES players(user_id),
  local_date date NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  observed_at timestamptz NOT NULL,
  drop_before numeric,
  drop_after numeric,
  loss_before numeric,
  adjustment numeric,
  reason text NOT NULL,
  computable boolean NOT NULL,
  PRIMARY KEY (local_date, adjustment_id)
) PARTITION BY RANGE (local_date);

CREATE TABLE IF NOT EXISTS player_quota_adjustments_default PARTITION OF player_quota_adjustments DEFAULT;
CREATE INDEX IF NOT EXISTS player_quota_adjustments_user_date_idx ON player_quota_adjustments (user_id, local_date, observed_at);

CREATE TABLE IF NOT EXISTS player_daily_quota (
  local_date date NOT NULL,
  user_id bigint NOT NULL REFERENCES players(user_id),
  initial_quota numeric,
  closing_quota numeric,
  income numeric,
  finalized_at timestamptz,
  source_snapshot_id text NOT NULL REFERENCES snapshot_versions(snapshot_id),
  PRIMARY KEY (local_date, user_id)
) PARTITION BY RANGE (local_date);

CREATE TABLE IF NOT EXISTS player_daily_quota_default PARTITION OF player_daily_quota DEFAULT;

CREATE TABLE IF NOT EXISTS map_metadata (
  map_id text NOT NULL,
  version integer NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (map_id, version)
);

CREATE TABLE IF NOT EXISTS retention_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  boundary_date date NOT NULL,
  rows_affected bigint NOT NULL DEFAULT 0,
  completed_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE snapshot_observations IS 'Request metadata only; raw response bodies remain in the 24-hour spool.';
COMMENT ON TABLE player_state_delta IS 'Sparse typed state changes; missing_fields distinguishes omission from null.';
COMMENT ON TABLE player_daily_quota IS 'Closed daily quota facts; current day rows are provisional until finalized_at is set.';
