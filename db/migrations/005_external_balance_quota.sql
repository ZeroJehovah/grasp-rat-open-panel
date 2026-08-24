-- Mark the pre-existing Drop-derived quota rows so the next stable snapshot
-- can rebuild the current-day baseline from external_balance_snapshot.
ALTER TABLE player_quota_current
  ADD COLUMN IF NOT EXISTS quota_source text;

UPDATE player_quota_current
SET quota_source = 'drop_derived'
WHERE quota_source IS NULL;
