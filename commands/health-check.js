#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const { Client } = require('pg');
const { collectorHealth } = require('../collector/health');

const DEFAULT_MAX_LATEST_SUCCESS_AGE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_VERSION_GAP_MS = 5 * 60 * 1000;
const DEFAULT_MIN_DISK_FREE_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_QUEUE_DEPTH = 1_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 2;
const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_API_RETRIES = 2;
const DEFAULT_API_RETRY_DELAY_MS = 250;

function numberOption(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseArgs(argv) {
  const options = {
    now: new Date(),
    maxLatestSuccessAgeMs: numberOption(process.env.GRASP_RAT_PANEL_HEALTH_MAX_SUCCESS_AGE_MS, DEFAULT_MAX_LATEST_SUCCESS_AGE_MS),
    maxVersionGapMs: numberOption(process.env.GRASP_RAT_PANEL_HEALTH_MAX_VERSION_GAP_MS, DEFAULT_MAX_VERSION_GAP_MS),
    minDiskFreeBytes: numberOption(process.env.GRASP_RAT_PANEL_HEALTH_MIN_DISK_FREE_BYTES, DEFAULT_MIN_DISK_FREE_BYTES),
    maxQueueDepth: numberOption(process.env.GRASP_RAT_PANEL_HEALTH_MAX_QUEUE_DEPTH, DEFAULT_MAX_QUEUE_DEPTH),
    maxConsecutiveFailures: numberOption(process.env.GRASP_RAT_PANEL_HEALTH_MAX_CONSECUTIVE_FAILURES, DEFAULT_MAX_CONSECUTIVE_FAILURES),
    httpTimeoutMs: numberOption(process.env.GRASP_RAT_PANEL_HEALTH_HTTP_TIMEOUT_MS, DEFAULT_HTTP_TIMEOUT_MS),
    apiRetries: numberOption(process.env.GRASP_RAT_PANEL_HEALTH_API_RETRIES, DEFAULT_API_RETRIES),
    apiRetryDelayMs: numberOption(process.env.GRASP_RAT_PANEL_HEALTH_API_RETRY_DELAY_MS, DEFAULT_API_RETRY_DELAY_MS),
    apiUrl: process.env.GRASP_RAT_PANEL_HEALTH_API_URL || 'http://127.0.0.1:19317/healthz'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--now') options.now = new Date(value());
    else if (arg === '--api-url') options.apiUrl = value();
    else if (arg === '--max-success-age-ms') options.maxLatestSuccessAgeMs = Number(value());
    else if (arg === '--max-version-gap-ms') options.maxVersionGapMs = Number(value());
    else if (arg === '--min-disk-free-bytes') options.minDiskFreeBytes = Number(value());
    else if (arg === '--max-queue-depth') options.maxQueueDepth = Number(value());
    else if (arg === '--max-consecutive-failures') options.maxConsecutiveFailures = Number(value());
    else if (arg === '--http-timeout-ms') options.httpTimeoutMs = Number(value());
    else if (arg === '--api-retries') options.apiRetries = Number(value());
    else if (arg === '--api-retry-delay-ms') options.apiRetryDelayMs = Number(value());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (Number.isNaN(options.now.getTime())) throw new Error('invalid --now date');
  for (const [key, value] of Object.entries(options)) {
    if (key !== 'now' && key !== 'apiUrl' && key !== 'help' && (!Number.isFinite(value) || value < 0)) throw new Error(`${key} must be a non-negative number`);
  }
  return options;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJson(urlString, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  const url = new URL(urlString);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, { timeout: timeoutMs, headers: { accept: 'application/json', 'user-agent': 'grasp-rat-panel-health-check/1.0' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let payload = null;
        try { payload = JSON.parse(body); } catch (_) { /* report status without echoing response body */ }
        resolve({ statusCode: response.statusCode || 0, payload });
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('health request timeout'), { code: 'ETIMEDOUT' })));
    request.on('error', reject);
  });
}

async function fetchJsonWithRetry(urlString, timeoutMs, retries = DEFAULT_API_RETRIES, retryDelayMs = DEFAULT_API_RETRY_DELAY_MS, fetcher = fetchJson) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetcher(urlString, timeoutMs);
      if (response.statusCode < 500 || attempt === retries) return response;
      lastError = Object.assign(new Error(`health endpoint returned HTTP ${response.statusCode}`), { code: `HTTP_${response.statusCode}` });
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
    }
    await wait(retryDelayMs);
  }
  throw lastError || new Error('health endpoint unavailable');
}

async function databaseHealth(connectionString, now = new Date()) {
  if (!connectionString) return { configured: false, ok: true, skipped: 'DATABASE_URL_not_set' };
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const result = await client.query(`SELECT observed_at
      FROM snapshot_versions
      WHERE completeness = 'steady'
      ORDER BY observed_at DESC
      LIMIT 2`);
    const latest = result.rows[0]?.observed_at ? Date.parse(result.rows[0].observed_at) : NaN;
    const previous = result.rows[1]?.observed_at ? Date.parse(result.rows[1].observed_at) : NaN;
    return {
      configured: true,
      ok: Number.isFinite(latest),
      latestObservedAt: Number.isFinite(latest) ? new Date(latest).toISOString() : null,
      latestAgeMs: Number.isFinite(latest) ? Math.max(0, now.getTime() - latest) : null,
      versionGapMs: Number.isFinite(latest) && Number.isFinite(previous) ? Math.max(0, latest - previous) : null
    };
  } catch (error) {
    return { configured: true, ok: false, errorCode: error.code || 'database_unavailable' };
  } finally {
    await client.end().catch(() => {});
  }
}

function evaluateHealth({ collector, database, api, now = new Date(), options = {} }) {
  const thresholds = {
    maxLatestSuccessAgeMs: options.maxLatestSuccessAgeMs ?? DEFAULT_MAX_LATEST_SUCCESS_AGE_MS,
    maxVersionGapMs: options.maxVersionGapMs ?? DEFAULT_MAX_VERSION_GAP_MS,
    minDiskFreeBytes: options.minDiskFreeBytes ?? DEFAULT_MIN_DISK_FREE_BYTES,
    maxQueueDepth: options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
    maxConsecutiveFailures: options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES
  };
  const failures = [];
  const warnings = [];
  const latestAgeMs = collector.latestSuccessVersionAgeMs;
  if (latestAgeMs === null || latestAgeMs > thresholds.maxLatestSuccessAgeMs) failures.push('collector_stale');
  if (collector.queueDepth > thresholds.maxQueueDepth) failures.push('queue_backlog');
  if (collector.diskFreeBytes !== null && collector.diskFreeBytes < thresholds.minDiskFreeBytes) failures.push('disk_low');
  if (collector.consecutiveFailures > thresholds.maxConsecutiveFailures) failures.push('collector_failures');
  if (collector.availableEgressGroups?.A === 0 || collector.availableEgressGroups?.B === 0) warnings.push('egress_group_unavailable');
  if (collector.healthProbeEgressCount > 0) warnings.push('egress_probe_required');
  if (collector.rawRetentionBacklogCount > 0) warnings.push('raw_retention_backlog');
  if (database && !database.ok) failures.push('database_unhealthy');
  if (database?.latestAgeMs !== null && database?.latestAgeMs > thresholds.maxLatestSuccessAgeMs) failures.push('database_stale');
  if (database?.versionGapMs !== null && database?.versionGapMs > thresholds.maxVersionGapMs) failures.push('version_gap');
  if (api && !api.ok) failures.push('api_unhealthy');
  return {
    ok: failures.length === 0,
    checkedAt: now.toISOString(),
    failures,
    warnings,
    thresholds,
    collector,
    database,
    api
  };
}

async function runHealthCheck(options = parseArgs([]), dependencies = {}) {
  const now = options.now || new Date();
  const collector = (dependencies.collectorHealth || collectorHealth)({
    stateFile: options.stateFile,
    queueDir: options.queueDir,
    rawDir: options.rawDir,
    egressConfigPath: options.egressConfigPath
  });
  const database = await (dependencies.databaseHealth || databaseHealth)(process.env.DATABASE_URL, now);
  let api;
  try {
    const response = await fetchJsonWithRetry(
      options.apiUrl,
      options.httpTimeoutMs,
      options.apiRetries,
      options.apiRetryDelayMs,
      dependencies.fetchJson || fetchJson
    );
    api = { ok: response.statusCode >= 200 && response.statusCode < 300 && response.payload?.ok === true, statusCode: response.statusCode };
  } catch (error) {
    api = { ok: false, errorCode: error.code || 'api_unavailable' };
  }
  return evaluateHealth({ collector, database, api, now, options });
}

if (require.main === module) {
  (async () => {
    try {
      const options = parseArgs(process.argv.slice(2));
      if (options.help) console.log('Usage: node commands/health-check.js [--now ISO] [--api-url URL]');
      else {
        const report = await runHealthCheck(options);
        console.log(JSON.stringify(report, null, 2));
        if (!report.ok) process.exitCode = 1;
      }
    } catch (error) {
      console.error(error?.stack || error);
      process.exitCode = 1;
    }
  })();
}

module.exports = { databaseHealth, evaluateHealth, fetchJson, fetchJsonWithRetry, parseArgs, runHealthCheck };
