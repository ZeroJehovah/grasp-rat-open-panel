#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function parseArgs(argv) {
  const options = {
    rawDir: process.env.GRASP_RAT_PANEL_SNAPSHOT_DIR || path.resolve(__dirname, '../../data/raw-snapshots'),
    queueDir: process.env.GRASP_RAT_PANEL_QUEUE_DIR || path.resolve(__dirname, '../../data/spool'),
    rawHours: Number(process.env.GRASP_RAT_PANEL_RAW_RETENTION_HOURS || 24),
    metadataDays: Number(process.env.GRASP_RAT_PANEL_METADATA_RETENTION_DAYS || 62),
    now: new Date(),
    dryRun: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--raw-dir') options.rawDir = path.resolve(value());
    else if (arg === '--queue-dir') options.queueDir = path.resolve(value());
    else if (arg === '--raw-hours') options.rawHours = Number(value());
    else if (arg === '--metadata-days') options.metadataDays = Number(value());
    else if (arg === '--now') options.now = new Date(value());
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.rawHours) || options.rawHours <= 0) throw new Error('raw retention must be positive');
  if (!Number.isFinite(options.metadataDays) || options.metadataDays < 62) throw new Error('metadata retention cannot be less than 62 days');
  if (Number.isNaN(options.now.getTime())) throw new Error('invalid --now');
  return options;
}

function readManifest(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch (_) { return []; }
  });
}

function runRetention(options) {
  const root = path.resolve(options.rawDir);
  const manifestPath = path.join(root, 'manifest.jsonl');
  const records = readManifest(manifestPath);
  const observedAtByObservationId = new Map(records.map(record => [record.observationId, record.observedAt || record.observed_at]));
  const committed = new Set();
  const processedDir = path.join(path.resolve(options.queueDir), 'processed');
  if (fs.existsSync(processedDir)) {
    for (const file of fs.readdirSync(processedDir).filter(name => name.endsWith('.json'))) {
      try {
        const item = JSON.parse(fs.readFileSync(path.join(processedDir, file), 'utf8'));
        if (item.observationId && ['projected', 'warming_up', 'invalid', 'duplicate'].includes(item.parseStatus || item.status)) committed.add(item.observationId);
      } catch (_) { /* a partial queue metadata file is not proof of commit */ }
    }
  }
  const rawCutoff = options.now.getTime() - options.rawHours * 60 * 60 * 1000;
  const metadataCutoff = options.now.getTime() - options.metadataDays * 24 * 60 * 60 * 1000;
  const rawDeletionAllowed = options.allowRawDeletion !== false;
  let eligible = 0;
  let deleted = 0;
  let skippedNotCommitted = 0;
  const errors = [];
  for (const record of rawDeletionAllowed ? records : []) {
    const observedAt = Date.parse(record.observedAt || record.observed_at || '');
    if (!record.file || !record.storedAsSnapshot || !Number.isFinite(observedAt) || observedAt >= rawCutoff) continue;
    eligible += 1;
    // A projector marks queue metadata as committed. Legacy raw runs without this
    // marker are retained deliberately so cleanup cannot outrun structured facts.
    const isCommitted = ['projected', 'duplicate', 'warming_up', 'invalid'].includes(record.parseStatus) || committed.has(record.observationId);
    if (!isCommitted) {
      skippedNotCommitted += 1;
      continue;
    }
    const target = path.join(root, record.file);
    try {
      if (!options.dryRun) fs.unlinkSync(target);
      deleted += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push({ file: record.file, error: error.message });
    }
  }
  const metadataRecords = rawDeletionAllowed ? records.filter(record => {
    const observedAt = Date.parse(record.observedAt || record.observed_at || '');
    return !Number.isFinite(observedAt) || observedAt >= metadataCutoff;
  }) : records;
  let processedBodiesDeleted = 0;
  let processedMetadataDeleted = 0;
  if (rawDeletionAllowed && fs.existsSync(processedDir)) {
    for (const file of fs.readdirSync(processedDir).filter(name => name.endsWith('.json'))) {
      const metadataPath = path.join(processedDir, file);
      let item;
      try { item = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch (_) { continue; }
      const observedAt = Date.parse(item.observedAt || item.observed_at || observedAtByObservationId.get(item.observationId) || '');
      const committed = ['projected', 'warming_up', 'invalid', 'duplicate'].includes(item.parseStatus || item.status);
      if (committed && Number.isFinite(observedAt) && observedAt < rawCutoff) {
        const bodyPath = path.join(processedDir, file.replace(/\.json$/, '.body'));
        try { if (!options.dryRun) fs.unlinkSync(bodyPath); processedBodiesDeleted += 1; } catch (error) { if (error.code !== 'ENOENT') errors.push({ file: path.basename(bodyPath), error: error.message }); }
      }
      if (Number.isFinite(observedAt) && observedAt < metadataCutoff) {
        try { if (!options.dryRun) fs.unlinkSync(metadataPath); processedMetadataDeleted += 1; } catch (error) { if (error.code !== 'ENOENT') errors.push({ file, error: error.message }); }
      }
    }
  }
  if (!options.dryRun && fs.existsSync(manifestPath) && metadataRecords.length !== records.length) {
    const temp = `${manifestPath}.${process.pid}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeSync(fd, metadataRecords.map(record => JSON.stringify(record)).join('\n') + (metadataRecords.length ? '\n' : ''), null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, manifestPath);
  }
  return { rawCutoff: new Date(rawCutoff).toISOString(), metadataCutoff: new Date(metadataCutoff).toISOString(), eligible, deleted, skippedNotCommitted, processedBodiesDeleted, processedMetadataDeleted, metadataRemaining: metadataRecords.length, errors, dryRun: options.dryRun, rawDeletionAllowed };
}

function businessDate(timestamp) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
}

async function runDatabaseRetention(options) {
  if (!process.env.DATABASE_URL || options.dryRun) return { skipped: true, reason: options.dryRun ? 'dry_run' : 'DATABASE_URL_not_set' };
  const boundary = businessDate(options.now.getTime() - options.metadataDays * 24 * 60 * 60 * 1000);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const open = await client.query('SELECT count(*)::int AS count FROM player_daily_quota WHERE local_date < $1::date AND finalized_at IS NULL', [boundary]);
    if (Number(open.rows[0]?.count || 0) > 0) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'daily_quota_not_finalized', boundaryDate: boundary, openRows: Number(open.rows[0].count) };
    }
    const statements = [
      ['state_checkpoint', `INSERT INTO player_state_base (snapshot_id, user_id, segment_id, schema_version, state, observed_at)
        SELECT c.snapshot_id, c.user_id, c.segment_id, COALESCE(s.schema_version, 'snapshot-v1'), c.state, c.observed_at
        FROM player_state_current c
        LEFT JOIN snapshot_versions s ON s.snapshot_id = c.snapshot_id
        ON CONFLICT (snapshot_id, user_id, segment_id) DO UPDATE SET schema_version = EXCLUDED.schema_version, state = EXCLUDED.state, observed_at = EXCLUDED.observed_at`, []],
      ['player_state_delta', 'DELETE FROM player_state_delta d USING snapshot_versions s WHERE d.snapshot_id = s.snapshot_id AND s.server_day < $1::date'],
      ['player_state_base', `DELETE FROM player_state_base b USING snapshot_versions s
        WHERE b.snapshot_id = s.snapshot_id AND s.server_day < $1::date
          AND NOT EXISTS (SELECT 1 FROM player_state_current c WHERE c.snapshot_id = b.snapshot_id AND c.user_id = b.user_id AND c.segment_id = b.segment_id)`],
      ['player_online_interval', 'DELETE FROM player_online_interval WHERE server_day < $1::date'],
      ['message_events', 'DELETE FROM message_events WHERE server_day < $1::date'],
      ['kill_events', 'DELETE FROM kill_events WHERE local_date < $1::date'],
      ['coin_drop_lifecycles', 'DELETE FROM coin_drop_lifecycles WHERE server_day < $1::date'],
      ['player_daily_stats', 'DELETE FROM player_daily_stats WHERE local_date < $1::date'],
      ['player_quota_adjustments', 'DELETE FROM player_quota_adjustments WHERE local_date < $1::date'],
      ['player_daily_quota', 'DELETE FROM player_daily_quota WHERE local_date < $1::date'],
      ['snapshot_observations', 'DELETE FROM snapshot_observations WHERE observed_at < ($1::date AT TIME ZONE \'Asia/Shanghai\')'],
      ['snapshot_versions', 'DELETE FROM snapshot_versions s WHERE s.server_day < $1::date AND NOT EXISTS (SELECT 1 FROM player_state_current c WHERE c.snapshot_id = s.snapshot_id)']
    ];
    const rows = {};
    for (const [name, sql, values = [boundary]] of statements) rows[name] = Number((await client.query(sql, values)).rowCount || 0);
    await client.query('INSERT INTO retention_audit (action, boundary_date, rows_affected, detail) VALUES ($1, $2::date, $3, $4::jsonb)', ['structured_retention', boundary, Object.values(rows).reduce((sum, value) => sum + value, 0), JSON.stringify(rows)]);
    await client.query('COMMIT');
    return { skipped: false, boundaryDate: boundary, rows };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  (async () => {
   try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node commands/retention.js [--raw-dir DIR] [--raw-hours 24] [--metadata-days 62] [--dry-run]');
    else {
      const database = await runDatabaseRetention(options);
      const raw = runRetention({ ...options, allowRawDeletion: Boolean(process.env.DATABASE_URL) && (!database.skipped || options.dryRun) });
      console.log(JSON.stringify({ type: 'retention-finished', raw, database }, null, 2));
    }
   } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
   }
  })();
}

module.exports = { parseArgs, readManifest, runRetention, runDatabaseRetention };
