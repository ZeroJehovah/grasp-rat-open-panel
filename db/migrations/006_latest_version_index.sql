-- getLatestVersion() 是每个 API 请求都会走的查询：版本轮询、算缓存键，以及 getMeta 和每个
-- 实时资源内部各自还要再查一次。它按全表的 observed_at 排序，而已有的
-- snapshot_versions_steady_time_idx 以 server_day 领头用不上，实测 5,516 行时是全表顺序
-- 扫描加 top-N 排序、5.0 ms，而这张表每天还要增长约 2,880 行。
CREATE INDEX IF NOT EXISTS snapshot_versions_steady_observed_at_idx
  ON snapshot_versions (observed_at DESC)
  WHERE completeness = 'steady';
