-- 原本这里建的是 snapshot_versions (observed_at DESC) WHERE completeness = 'steady'。
-- 实时读路径后来不再只认 `steady`（见 007），那个谓词让索引对任何现存查询都不可用，只剩
-- 写入时的维护开销，所以改成把它删掉。索引本身由 007 以不带谓词的同形索引接手。
-- 迁移目录每次部署都会按文件名顺序整体重放，因此这条必须保持幂等。
DROP INDEX IF EXISTS snapshot_versions_steady_observed_at_idx;
