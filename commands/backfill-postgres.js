#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { PostgresPanelStore } = require('../storage/postgres-store');
const { businessDateRange, localDateFromTimestamp } = require('../domain/snapshot');

function parseArgs(argv) {
  const options = {
    rawDir: process.env.GRASP_RAT_PANEL_SNAPSHOT_DIR || path.resolve(__dirname, '../../data/raw-snapshots'),
    from: null,
    to: null,
    dryRun: false,
    minSteadyEntities: Number(process.env.PANEL_MIN_STEADY_ENTITIES || 900)
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--raw-dir') options.rawDir = path.resolve(value());
    else if (arg === '--from') options.from = value();
    else if (arg === '--to') options.to = value();
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--min-steady-entities') options.minSteadyEntities = Number(value());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.help) return options;
  if (!options.from || !options.to) throw new Error('--from and --to are required; this command never imports an unbounded live directory');
  businessDateRange(options.from, options.to);
  if (!Number.isInteger(options.minSteadyEntities) || options.minSteadyEntities < 0) throw new Error('min steady entities must be a non-negative integer');
  return options;
}

function readManifest(directory) {
  const manifestPath = path.join(directory, 'manifest.jsonl');
  const byFile = new Map();
  if (!fs.existsSync(manifestPath)) return byFile;
  for (const line of fs.readFileSync(manifestPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.file) byFile.set(item.file, item);
    } catch (_) { /* a torn final line cannot make a raw body unsafe to read */ }
  }
  return byFile;
}

function listBackfillItems(options) {
  const directory = path.resolve(options.rawDir);
  const manifest = readManifest(directory);
  if (!fs.existsSync(directory)) throw new Error(`raw directory does not exist: ${directory}`);
  return fs.readdirSync(directory)
    .filter(file => file.endsWith('.json') && file !== 'manifest.jsonl')
    .map(file => {
      const filePath = path.join(directory, file);
      const metadata = manifest.get(file) || {};
      const stat = fs.statSync(filePath);
      const observedAt = metadata.observedAt || metadata.observed_at || new Date(stat.mtimeMs).toISOString();
      return { file, filePath, metadata, observedAt, businessDate: localDateFromTimestamp(observedAt) };
    })
    .filter(item => item.businessDate && item.businessDate >= options.from && item.businessDate <= options.to)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.file.localeCompare(b.file));
}

async function targetIsEmpty(connectionString, ClientClass = Client) {
  const client = new ClientClass({ connectionString });
  await client.connect();
  try {
    const result = await client.query(`SELECT
      (SELECT count(*) FROM snapshot_observations)::bigint AS observations,
      (SELECT count(*) FROM snapshot_versions)::bigint AS versions,
      (SELECT count(*) FROM players)::bigint AS players,
      (SELECT count(*) FROM message_events)::bigint AS messages,
      (SELECT count(*) FROM kill_events)::bigint AS kills`);
    const row = result.rows[0];
    const counts = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
    return { empty: Object.values(counts).every(value => value === 0), counts };
  } finally {
    await client.end();
  }
}

async function runBackfill(options, dependencies = {}) {
  const items = listBackfillItems(options);
  const connectionString = options.connectionString || process.env.PANEL_BACKFILL_DATABASE_URL;
  if (!options.dryRun && !connectionString) throw new Error('PANEL_BACKFILL_DATABASE_URL is required; the live DATABASE_URL is never used implicitly');
  if (options.dryRun) return { dryRun: true, files: items.length, from: options.from, to: options.to };

  const empty = await (dependencies.targetIsEmpty || targetIsEmpty)(connectionString);
  if (!empty.empty) {
    const error = new Error('backfill target database is not empty; refusing to mix historical and live state');
    error.code = 'backfill_target_not_empty';
    error.counts = empty.counts;
    throw error;
  }

  const StoreClass = dependencies.StoreClass || PostgresPanelStore;
  const store = dependencies.store || new StoreClass({ connectionString, minSteadyEntities: options.minSteadyEntities });
  const counts = { observations: 0, projected: 0, warmingUp: 0, invalid: 0, duplicates: 0 };
  try {
    await store.hydrate();
    for (const item of items) {
      const metadata = item.metadata;
      const result = await store.applyObservation(fs.readFileSync(item.filePath), {
        observationId: metadata.observationId || `backfill-${item.file}`,
        observedAt: item.observedAt,
        receivedAt: metadata.receivedAt || metadata.received_at || item.observedAt,
        rawPath: item.filePath,
        payloadHash: metadata.payloadHash || metadata.sha256,
        bytes: metadata.bytes,
        statusCode: metadata.statusCode || 200,
        durationMs: metadata.durationMs,
        egressId: metadata.egressId,
        egressGroup: metadata.egressGroup,
        retryNo: metadata.retryNo || 0
      });
      counts.observations += 1;
      if (result.status === 'projected') counts.projected += 1;
      else if (result.status === 'warming_up') counts.warmingUp += 1;
      else if (result.status === 'duplicate') counts.duplicates += 1;
      else counts.invalid += 1;
    }
    const rebuild = store.engine?.verifyRebuild ? store.engine.verifyRebuild() : null;
    if (rebuild && !rebuild.ok) throw new Error('backfill in-memory rebuild verification failed');
    return { dryRun: false, from: options.from, to: options.to, files: items.length, ...counts, rebuild };
  } finally {
    if (store.close) await store.close();
  }
}

if (require.main === module) {
  (async () => {
    try {
      const options = parseArgs(process.argv.slice(2));
      if (options.help) console.log('Usage: PANEL_BACKFILL_DATABASE_URL=... node commands/backfill-postgres.js --raw-dir DIR --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run]');
      else console.log(JSON.stringify({ type: 'postgres-backfill-finished', ...(await runBackfill(options)) }, null, 2));
    } catch (error) {
      console.error(error?.stack || error);
      process.exitCode = 1;
    }
  })();
}

module.exports = { parseArgs, readManifest, listBackfillItems, targetIsEmpty, runBackfill };
