#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DEFAULT_ORIGIN = 'https://grasp-rat-game.h-e.top';
const DEFAULT_PATH = '/snapshot';
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 20_000;

function parseArgs(argv) {
  const options = {
    origin: process.env.GRASP_RAT_PANEL_GAME_ORIGIN || DEFAULT_ORIGIN,
    snapshotPath: process.env.GRASP_RAT_PANEL_SNAPSHOT_PATH || DEFAULT_PATH,
    intervalMs: Number(process.env.GRASP_RAT_PANEL_INTERVAL_MS || DEFAULT_INTERVAL_MS),
    timeoutMs: Number(process.env.GRASP_RAT_PANEL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    outputDir: process.env.GRASP_RAT_PANEL_SNAPSHOT_DIR || path.resolve(__dirname, '../data/raw-snapshots'),
    until: process.env.GRASP_RAT_PANEL_UNTIL || '',
    once: false,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    if (arg === '--origin') options.origin = value();
    else if (arg === '--path') options.snapshotPath = value();
    else if (arg === '--interval-ms') options.intervalMs = Number(value());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(value());
    else if (arg === '--output-dir') options.outputDir = path.resolve(value());
    else if (arg === '--until') options.until = value();
    else if (arg === '--once') options.once = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1000) throw new Error('interval must be at least 1000ms');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('timeout must be at least 1000ms');
  if (options.until) {
    const untilMs = Date.parse(options.until);
    if (!Number.isFinite(untilMs)) throw new Error(`invalid --until date: ${options.until}`);
    options.untilMs = untilMs;
  } else {
    options.untilMs = Infinity;
  }
  return options;
}

function usage() {
  return [
    'Usage: node snapshot-collector.js [options]',
    '',
    '  --origin <url>       Game origin (default: https://grasp-rat-game.h-e.top)',
    '  --path <path>        Snapshot path (default: /snapshot)',
    '  --interval-ms <ms>   Poll interval (default: 30000)',
    '  --timeout-ms <ms>    Request timeout (default: 20000)',
    '  --output-dir <dir>   Raw snapshot output directory',
    '  --until <date>       Stop at an ISO-8601 date/time',
    '  --once               Fetch one snapshot and exit',
    '  -h, --help           Show this help'
  ].join('\n');
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function requestSnapshot(options, now = () => Date.now()) {
  const url = new URL(options.snapshotPath, options.origin);
  const transport = url.protocol === 'http:' ? http : https;
  const startedAtMs = now();
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'grasp-rat-open-panel-snapshot-collector/0.1'
      },
      timeout: options.timeoutMs
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
        durationMs: Math.max(0, now() - startedAtMs)
      }));
    });
    request.on('timeout', () => request.destroy(new Error(`request timeout after ${options.timeoutMs}ms`)));
    request.on('error', reject);
    request.end();
  });
}

function safeSnapshotSummary(body) {
  try {
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { validJson: false };
    const entities = Array.isArray(payload.entities) ? payload.entities : null;
    return {
      validJson: true,
      type: typeof payload.type === 'string' ? payload.type : '',
      tick: Number.isFinite(Number(payload.tick)) ? Number(payload.tick) : null,
      totalEntities: Number.isFinite(Number(payload.total_entities)) ? Number(payload.total_entities) : null,
      entityCount: entities ? entities.length : null,
      bulletCount: Array.isArray(payload.bullets) ? payload.bullets.length : null,
      coinDropCount: Array.isArray(payload.coin_drops) ? payload.coin_drops.length : null,
      messageCount: Array.isArray(payload.messages) ? payload.messages.length : null,
      hasEntitiesArray: Boolean(entities)
    };
  } catch (_) {
    return { validJson: false };
  }
}

function fileTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function writeAtomically(filePath, body) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, body, { flag: 'wx' });
  fs.renameSync(temporary, filePath);
}

function persistObservation(result, options, observedAt = new Date()) {
  ensureDirectory(options.outputDir);
  const hash = crypto.createHash('sha256').update(result.body).digest('hex');
  const summary = safeSnapshotSummary(result.body);
  const isSnapshot = result.statusCode >= 200 && result.statusCode < 300 && summary.validJson && summary.hasEntitiesArray;
  const suffix = isSnapshot ? `${summary.tick ?? 'notick'}-${hash.slice(0, 16)}.json` : `http-${result.statusCode || 'error'}-${hash.slice(0, 16)}.bin`;
  const fileName = `${fileTimestamp(observedAt)}-${suffix}`;
  const filePath = path.join(options.outputDir, fileName);
  writeAtomically(filePath, result.body);
  const metadata = {
    observedAt: observedAt.toISOString(),
    statusCode: result.statusCode,
    durationMs: result.durationMs,
    bytes: result.body.length,
    sha256: hash,
    file: fileName,
    storedAsSnapshot: isSnapshot,
    ...summary
  };
  const manifestPath = path.join(options.outputDir, 'manifest.jsonl');
  fs.appendFileSync(manifestPath, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8' });
  return metadata;
}

async function collectOnce(options, dependencies = {}) {
  const request = dependencies.requestSnapshot || requestSnapshot;
  const clock = dependencies.now || (() => Date.now());
  const observedAt = new Date(clock());
  try {
    const result = await request(options, clock);
    const metadata = persistObservation(result, options, observedAt);
    return { ok: metadata.storedAsSnapshot, metadata };
  } catch (error) {
    ensureDirectory(options.outputDir);
    const metadata = { observedAt: observedAt.toISOString(), ok: false, error: error?.message || String(error) };
    fs.appendFileSync(path.join(options.outputDir, 'manifest.jsonl'), `${JSON.stringify(metadata)}\n`);
    return { ok: false, metadata };
  }
}

async function runCollector(options, dependencies = {}) {
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const clock = dependencies.now || (() => Date.now());
  let polls = 0;
  let successes = 0;
  let failures = 0;
  let stopped = false;
  let nextPollAtMs = clock();
  while (!stopped && clock() < options.untilMs) {
    const waitMs = Math.max(0, nextPollAtMs - clock());
    if (waitMs > 0) await sleep(waitMs);
    if (clock() >= options.untilMs) break;
    polls += 1;
    const result = await collectOnce(options, dependencies);
    if (result.ok) successes += 1;
    else failures += 1;
    if (options.once || clock() >= options.untilMs) break;
    nextPollAtMs += options.intervalMs;
  }
  return { polls, successes, failures, stoppedAt: new Date(clock()).toISOString() };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  ensureDirectory(options.outputDir);
  const result = await runCollector(options);
  console.log(JSON.stringify({ type: 'collector-finished', outputDir: options.outputDir, ...result }));
  return result.failures && !result.successes ? 1 : 0;
}

if (require.main === module) {
  main().then(code => process.exitCode = code).catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_ORIGIN,
  DEFAULT_PATH,
  parseArgs,
  safeSnapshotSummary,
  persistObservation,
  collectOnce,
  runCollector,
  requestSnapshot
};
