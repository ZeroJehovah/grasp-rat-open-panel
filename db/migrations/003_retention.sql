-- Entity lifecycle records may outlive the snapshot metadata that first/last
-- observed them. Keep the IDs as provenance text without blocking the
-- retention boundary when their referenced snapshot version is removed.
ALTER TABLE player_entity_history DROP CONSTRAINT IF EXISTS player_entity_history_first_snapshot_id_fkey;
ALTER TABLE player_entity_history DROP CONSTRAINT IF EXISTS player_entity_history_last_snapshot_id_fkey;
