-- Keep this migration for databases initialized before the evidence columns
-- were added to the initial schema.
ALTER TABLE kill_events ADD COLUMN IF NOT EXISTS victim_position jsonb;
ALTER TABLE kill_events ADD COLUMN IF NOT EXISTS killer_position jsonb;
ALTER TABLE kill_events ADD COLUMN IF NOT EXISTS victim_stamina_5s numeric;
ALTER TABLE kill_events ADD COLUMN IF NOT EXISTS victim_stamina_5s_limit numeric;
ALTER TABLE snapshot_versions ADD COLUMN IF NOT EXISTS version_token text;
UPDATE snapshot_versions SET version_token = snapshot_id WHERE version_token IS NULL;
ALTER TABLE snapshot_versions ALTER COLUMN version_token SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS snapshot_versions_version_token_idx ON snapshot_versions (version_token);
