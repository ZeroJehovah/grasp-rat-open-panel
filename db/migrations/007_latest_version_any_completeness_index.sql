-- getLatestVersion() 是每个 API 请求都会走的查询：版本轮询、算缓存键，以及 getMeta 和每个
-- 实时资源内部各自还要再查一次。它按全表的 observed_at 排序，而 001 建的
-- snapshot_versions_steady_time_idx 以 server_day 领头用不上。
--
-- 这个索引原来带 `WHERE completeness = 'steady'`（006）。世界重启后实体集合要几分钟才长回
-- 来，那段时间每个版本都是 `warming_up`，按 `steady` 取最新版本会一直回答重启前那一天的
-- 快照，所以查询去掉了 completeness 过滤——于是也用不上那个部分索引了，实测退回全表顺序
-- 扫描加 top-N 排序：6,254 行 5.4 ms，而这张表每天还要增长约 2,880 行。换成不带谓词的同形
-- 索引后同一查询降到 0.07 ms。
CREATE INDEX IF NOT EXISTS snapshot_versions_observed_at_idx
  ON snapshot_versions (observed_at DESC);
