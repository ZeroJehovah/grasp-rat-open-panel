-- Keep date-keyed facts in a rolling set of daily partitions. The default
-- partitions remain as a safety net for an unexpected date; the maintenance
-- function moves rows into known partitions before attaching the default.
CREATE OR REPLACE FUNCTION ensure_panel_date_partitions(anchor_date date)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  table_spec record;
  day date;
  partition_name text;
  parent_regclass regclass;
  default_regclass regclass;
BEGIN
  IF anchor_date IS NULL THEN
    RAISE EXCEPTION 'anchor_date is required';
  END IF;

  FOR table_spec IN
    SELECT * FROM (VALUES
      ('message_events', 'message_events_default', 'message_events_day', 'server_day'),
      ('kill_events', 'kill_events_default', 'kill_events_day', 'local_date'),
      ('coin_drop_lifecycles', 'coin_drop_lifecycles_default', 'coin_drop_lifecycles_day', 'server_day'),
      ('player_daily_stats', 'player_daily_stats_default', 'player_daily_stats_day', 'local_date'),
      ('player_quota_adjustments', 'player_quota_adjustments_default', 'player_quota_adjustments_day', 'local_date'),
      ('player_daily_quota', 'player_daily_quota_default', 'player_daily_quota_day', 'local_date')
    ) AS definitions(parent_name, default_name, partition_prefix, key_name)
  LOOP
    parent_regclass := to_regclass(format('public.%I', table_spec.parent_name));
    default_regclass := to_regclass(format('public.%I', table_spec.default_name));
    IF parent_regclass IS NULL OR default_regclass IS NULL THEN
      RAISE EXCEPTION 'partitioned table or default partition is missing: % / %', table_spec.parent_name, table_spec.default_name;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent = parent_regclass AND inhrelid = default_regclass) THEN
      EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', table_spec.parent_name, table_spec.default_name);
    END IF;

    day := anchor_date - 62;
    WHILE day <= anchor_date LOOP
      partition_name := table_spec.partition_prefix || '_' || to_char(day, 'YYYYMMDD');
      IF to_regclass(format('public.%I', partition_name)) IS NULL THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
          partition_name, table_spec.parent_name, day, day + 1
        );
      ELSIF NOT EXISTS (
        SELECT 1
        FROM pg_inherits
        WHERE inhparent = parent_regclass
          AND inhrelid = to_regclass(format('public.%I', partition_name))
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
          table_spec.parent_name, partition_name, day, day + 1
        );
      END IF;

      EXECUTE format(
        'INSERT INTO %I SELECT * FROM %I WHERE %I = $1 ON CONFLICT DO NOTHING',
        partition_name, table_spec.default_name, table_spec.key_name
      ) USING day;
      EXECUTE format(
        'DELETE FROM %I WHERE %I = $1',
        table_spec.default_name, table_spec.key_name
      ) USING day;
      day := day + 1;
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent = parent_regclass AND inhrelid = default_regclass) THEN
      EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I DEFAULT', table_spec.parent_name, table_spec.default_name);
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION prune_panel_date_partitions(boundary_date date)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  table_spec record;
  child record;
  partition_day date;
  dropped jsonb := '{}'::jsonb;
  count_dropped integer;
BEGIN
  IF boundary_date IS NULL THEN
    RAISE EXCEPTION 'boundary_date is required';
  END IF;

  FOR table_spec IN
    SELECT * FROM (VALUES
      ('message_events', 'message_events_day'),
      ('kill_events', 'kill_events_day'),
      ('coin_drop_lifecycles', 'coin_drop_lifecycles_day'),
      ('player_daily_stats', 'player_daily_stats_day'),
      ('player_quota_adjustments', 'player_quota_adjustments_day'),
      ('player_daily_quota', 'player_daily_quota_day')
    ) AS definitions(parent_name, partition_prefix)
  LOOP
    count_dropped := 0;
    FOR child IN
      SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = to_regclass(format('public.%I', table_spec.parent_name))
        AND c.relname LIKE table_spec.partition_prefix || '\_%' ESCAPE '\'
    LOOP
      partition_day := to_date(substring(child.relname FROM length(table_spec.partition_prefix) + 2), 'YYYYMMDD');
      IF partition_day < boundary_date THEN
        EXECUTE format('DROP TABLE %I', child.relname);
        count_dropped := count_dropped + 1;
      END IF;
    END LOOP;
    dropped := dropped || jsonb_build_object(table_spec.parent_name, count_dropped);
  END LOOP;
  RETURN dropped;
END;
$function$;

SELECT ensure_panel_date_partitions((now() AT TIME ZONE 'Asia/Shanghai')::date);
