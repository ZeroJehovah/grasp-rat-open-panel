#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const { EgressScheduler, loadEgressPlan, classifyFailure } = require('./collector/egress');
const { DurableObservationQueue } = require('./collector/queue');
const { ProjectionEngine } = require('./domain/projector');
const { diskFreeBytes } = require('./collector/health');

const DEFAULT_ORIGIN = 'https://grasp-rat-game.h-e.top';
const DEFAULT_PATH = '/snapshot';
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_QUEUE_DIR = path.resolve(__dirname, '../data/spool');
const DEFAULT_STATE_FILE = path.resolve(__dirname, '../data/collector-state.json');

function parseArgs(argv) {
  const outputDir = process.env.GRASP_RAT_PANEL_SNAPSHOT_DIR || path.resolve(__dirname, '../data/raw-snapshots');
  const options = {
    origin: process.env.GRASP_RAT_PANEL_GAME_ORIGIN || DEFAULT_ORIGIN,
    snapshotPath: process.env.GRASP_RAT_PANEL_SNAPSHOT_PATH || DEFAULT_PATH,
    intervalMs: Number(process.env.GRASP_RAT_PANEL_INTERVAL_MS || DEFAULT_INTERVAL_MS),
    timeoutMs: Number(process.env.GRASP_RAT_PANEL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    outputDir,
    queueDir: process.env.GRASP_RAT_PANEL_QUEUE_DIR || DEFAULT_QUEUE_DIR,
    stateFile: process.env.GRASP_RAT_PANEL_STATE_FILE || DEFAULT_STATE_FILE,
    egressConfigPath: process.env.GRASP_RAT_PANEL_EGRESS_CONFIG || '',
    minSteadyEntities: Number(process.env.GRASP_RAT_PANEL_MIN_STEADY_ENTITIES || 900),
    until: process.env.GRASP_RAT_PANEL_UNTIL || '',
    extraRetryMax: Number(process.env.GRASP_RAT_PANEL_EXTRA_RETRY_MAX || 1),
    retryJitterMs: Number(process.env.GRASP_RAT_PANEL_RETRY_JITTER_MS || 250),
    extraRetryWindowMs: Number(process.env.GRASP_RAT_PANEL_EXTRA_RETRY_WINDOW_MS || 10_000),
    benchmarkRetryMs: Number(process.env.GRASP_RAT_PANEL_EGRESS_BENCHMARK_RETRY_MS || 5 * 60_000),
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
    else if (arg === '--queue-dir') options.queueDir = path.resolve(value());
    else if (arg === '--state-file') options.stateFile = path.resolve(value());
    else if (arg === '--egress-config') options.egressConfigPath = path.resolve(value());
    else if (arg === '--min-steady-entities') options.minSteadyEntities = Number(value());
    else if (arg === '--extra-retry-max') options.extraRetryMax = Number(value());
    else if (arg === '--retry-jitter-ms') options.retryJitterMs = Number(value());
    else if (arg === '--extra-retry-window-ms') options.extraRetryWindowMs = Number(value());
    else if (arg === '--benchmark-retry-ms') options.benchmarkRetryMs = Number(value());
    else if (arg === '--until') options.until = value();
    else if (arg === '--once') options.once = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1000) throw new Error('interval must be at least 1000ms');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('timeout must be at least 1000ms');
  if (!Number.isFinite(options.minSteadyEntities) || options.minSteadyEntities < 0) throw new Error('min steady entities must be non-negative');
  if (!Number.isFinite(options.extraRetryMax) || options.extraRetryMax < 0) throw new Error('extra retry max must be non-negative');
  if (!Number.isFinite(options.extraRetryWindowMs) || options.extraRetryWindowMs <= 0) throw new Error('extra retry window must be positive');
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
    '  --origin <url>             Game origin (default: https://grasp-rat-game.h-e.top)',
    '  --path <path>              Snapshot path (default: /snapshot)',
    '  --interval-ms <ms>         Poll interval (default: 15000)',
    '  --timeout-ms <ms>          Request timeout (default: 20000)',
    '  --output-dir <dir>         Raw snapshot spool directory',
    '  --queue-dir <dir>          Durable observation queue directory',
    '  --state-file <file>        Atomic egress scheduler state file',
    '  --egress-config <file>     JSON array of four egress labels',
    '  --min-steady-entities <n>  Warming-up threshold (default: 900)',
    '  --extra-retry-max <n>      Retry window limit after both groups fail',
    '  --extra-retry-window-ms <n> Maximum total time for extra retries',
    '  --benchmark-retry-ms <n>   Retry delay when no daily benchmark egress succeeds',
    '  --until <date>             Stop at an ISO-8601 date/time',
    '  --once                     Fetch one round and exit',
    '  -h, --help                 Show this help'
  ].join('\n');
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function appendDurably(filePath, line) {
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(fd, line, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function requestSnapshot(options, now = () => Date.now(), egress = null) {
  const url = new URL(options.snapshotPath, options.origin);
  const transport = url.protocol === 'http:' ? http : https;
  const startedAtMs = now();
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: 'GET',
      localAddress: egress?.localAddress,
      headers: {
        accept: 'application/json',
        'user-agent': 'grasp-rat-open-panel-snapshot-collector/1.0'
      },
      timeout: options.timeoutMs
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes <= Number(options.maxResponseBytes || 20 * 1024 * 1024)) chunks.push(buffer);
        else response.destroy(new Error('snapshot response exceeds configured maximum'));
      });
      response.on('end', () => resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
        durationMs: Math.max(0, now() - startedAtMs)
      }));
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error(`request timeout after ${options.timeoutMs}ms`), { code: 'ETIMEDOUT' })));
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
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.([0-9]{3})Z$/, '$1Z');
}

function writeAtomically(filePath, body) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
}

function persistObservation(result, options, observedAt = new Date(), context = {}) {
  ensureDirectory(options.outputDir);
  const body = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body || '');
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const summary = safeSnapshotSummary(body);
  const isSuccessfulResponse = result.statusCode >= 200 && result.statusCode < 300;
  const isSnapshot = isSuccessfulResponse;
  const validSnapshot = isSuccessfulResponse && summary.validJson && summary.hasEntitiesArray;
  const observationId = context.observationId || `obs-${crypto.randomUUID()}`;
  let fileName = null;
  let rawPath = null;
  if (isSnapshot) {
    const suffix = summary.validJson && summary.hasEntitiesArray
      ? `${summary.tick ?? 'notick'}-${hash.slice(0, 16)}-${observationId.slice(-8)}.json`
      : `response-${result.statusCode || 'success'}-${hash.slice(0, 16)}-${observationId.slice(-8)}.bin`;
    fileName = `${fileTimestamp(observedAt)}-${suffix}`;
    rawPath = path.join(options.outputDir, fileName);
    writeAtomically(rawPath, body);
  }
  const metadata = {
    observationId,
    observedAt: observedAt.toISOString(),
    receivedAt: new Date().toISOString(),
    statusCode: result.statusCode || 0,
    durationMs: result.durationMs ?? null,
    bytes: body.length,
    sha256: hash,
    payloadHash: hash,
    file: fileName,
    rawPath,
    storedAsSnapshot: isSnapshot,
    validSnapshot,
    parseStatus: isSnapshot ? 'pending' : 'invalid',
    egressId: context.egressId || null,
    egressGroup: context.egressGroup || null,
    retryNo: context.retryNo || 0,
    failureCategory: context.failureCategory || classifyFailure(result),
    error: context.error || null,
    ...summary
  };
  const manifestPath = path.join(options.outputDir, 'manifest.jsonl');
  appendDurably(manifestPath, `${JSON.stringify(metadata)}\n`);
  return metadata;
}

function persistRequestError(error, options, observedAt, context = {}) {
  ensureDirectory(options.outputDir);
  const metadata = {
    observationId: context.observationId || `obs-${crypto.randomUUID()}`,
    observedAt: observedAt.toISOString(),
    receivedAt: new Date().toISOString(),
    statusCode: 0,
    durationMs: context.durationMs ?? null,
    bytes: 0,
    sha256: null,
    payloadHash: null,
    file: null,
    rawPath: null,
    storedAsSnapshot: false,
    parseStatus: 'request_failed',
    egressId: context.egressId || null,
    egressGroup: context.egressGroup || null,
    retryNo: context.retryNo || 0,
    failureCategory: context.failureCategory || classifyFailure(null, error),
    error: error?.message || String(error)
  };
  appendDurably(path.join(options.outputDir, 'manifest.jsonl'), `${JSON.stringify(metadata)}\n`);
  return metadata;
}

async function enqueueSnapshot(queue, metadata, body) {
  if (!queue) return null;
  return queue.enqueue({
    ...metadata,
    observationId: metadata.observationId,
    observedAt: metadata.observedAt,
    rawPath: metadata.rawPath
  }, metadata.storedAsSnapshot ? body : Buffer.alloc(0));
}

async function collectOnce(options, dependencies = {}) {
  const request = dependencies.requestSnapshot || requestSnapshot;
  const clock = dependencies.now || (() => Date.now());
  const observedAt = new Date(clock());
  const egress = dependencies.egress || null;
  const context = {
    egressId: egress?.id,
    egressGroup: egress?.group,
    retryNo: dependencies.retryNo || 0,
    observationId: dependencies.observationId
  };
  try {
    const result = await request(options, clock, egress);
    const metadata = persistObservation(result, options, observedAt, context);
    await enqueueSnapshot(dependencies.queue, metadata, Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body || ''));
    return { ok: metadata.validSnapshot, metadata, result };
  } catch (error) {
    const metadata = persistRequestError(error, options, observedAt, { ...context, failureCategory: classifyFailure(null, error) });
    await enqueueSnapshot(dependencies.queue, metadata, Buffer.alloc(0));
    return { ok: false, metadata, error };
  }
}

async function runAttempt(options, dependencies, scheduler, egress, queue, retryNo, context = {}) {
  const clock = dependencies.now || (() => Date.now());
  scheduler.markAttempt(egress, clock());
  const request = dependencies.requestSnapshot || requestSnapshot;
  const observedAt = new Date(clock());
  let result;
  let error = null;
  try {
    result = await request(options, clock, egress);
  } catch (requestError) {
    error = requestError;
    result = { statusCode: 0, body: Buffer.alloc(0), durationMs: null };
  }
  const resultWithVersion = !error && result.body
    ? { ...result, payloadHash: crypto.createHash('sha256').update(result.body).digest('hex') }
    : result;
  const failureCategory = scheduler.markResult(egress, resultWithVersion, clock(), error, context);
  const metadata = error
    ? persistRequestError(error, options, observedAt, { egressId: egress.id, egressGroup: egress.group, retryNo, failureCategory })
    : persistObservation(result, options, observedAt, { egressId: egress.id, egressGroup: egress.group, retryNo, failureCategory });
  await enqueueSnapshot(queue, metadata, error ? Buffer.alloc(0) : result.body);
  return {
    ok: Boolean(!error && metadata.validSnapshot),
    metadata,
    result: resultWithVersion,
    error,
    failureCategory
  };
}

function businessDateAt(value = Date.now()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function benchmarkSelection(results, scheduler) {
  const successful = results
    .filter(result => result.success)
    .sort((a, b) => Number(a.durationMs ?? Number.MAX_SAFE_INTEGER) - Number(b.durationMs ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
  const selected = [];
  const selectedIds = new Set();
  for (const group of ['A', 'B']) {
    for (const result of successful.filter(item => item.group === group).slice(0, scheduler.activePerGroup)) {
      if (selected.length >= scheduler.activeCount) break;
      selected.push(result);
      selectedIds.add(result.id);
    }
  }
  for (const result of successful) {
    if (selected.length >= scheduler.activeCount) break;
    if (!selectedIds.has(result.id)) {
      selected.push(result);
      selectedIds.add(result.id);
    }
  }
  return selected.map(result => result.id);
}

async function runEgressBenchmark(options, dependencies, scheduler, queue) {
  const clock = dependencies.now || (() => Date.now());
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const businessDate = businessDateAt(clock());
  const results = [];
  for (const egress of scheduler.egresses) {
    const state = scheduler.stateFor(egress);
    const waitMs = Math.max(0, Number(state?.next_eligible_at || 0) - clock());
    if (waitMs > 0) await sleep(waitMs);
    const startedAt = clock();
    const attempt = await runAttempt(options, dependencies, scheduler, egress, queue, 0, { benchmark: true });
    const statusCode = attempt.result?.statusCode || attempt.metadata?.statusCode || 0;
    const success = Boolean(!attempt.error && statusCode >= 200 && statusCode < 300 && attempt.metadata?.validSnapshot);
    results.push({
      id: egress.id,
      group: egress.group,
      localAddress: egress.localAddress || null,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(clock()).toISOString(),
      statusCode,
      durationMs: attempt.result?.durationMs ?? attempt.metadata?.durationMs ?? null,
      bytes: attempt.metadata?.bytes ?? 0,
      validSnapshot: Boolean(attempt.metadata?.validSnapshot),
      success,
      failureCategory: attempt.failureCategory || null
    });
  }
  const selectedIds = benchmarkSelection(results, scheduler);
  const completedAt = clock();
  if (selectedIds.length > 0) scheduler.setDailySelection(businessDate, selectedIds, completedAt, results);
  else scheduler.recordBenchmarkAttempt(completedAt, results);
  return { businessDate, results, selectedIds, completedAt: new Date(completedAt).toISOString() };
}

async function runRound(options, dependencies, scheduler, queue) {
  const clock = dependencies.now || (() => Date.now());
  const attempted = new Set();
  const probe = scheduler.chooseProbe?.(clock(), attempted);
  let probeAttempt = null;
  if (probe) {
    attempted.add(probe.id);
    probeAttempt = await runAttempt(options, dependencies, scheduler, probe, queue, 0, { probe: true });
    // If all regular exits have disappeared, a successful health probe is a
    // safe temporary source for one snapshot while the normal pool recovers.
    if (probeAttempt.ok && scheduler.runtimePoolIds().size === 0) {
      return { ...probeAttempt, extraRetries: 0, probe: true };
    }
  }
  const firstGroup = scheduler.state.nextGroup === 'B' ? 'B' : 'A';
  const groups = [firstGroup, firstGroup === 'A' ? 'B' : 'A'];
  let lastAttempt = null;
  for (let index = 0; index < groups.length; index += 1) {
    const egress = scheduler.choose(groups[index], clock(), attempted);
    if (!egress) continue;
    attempted.add(egress.id);
    lastAttempt = await runAttempt(options, dependencies, scheduler, egress, queue, 0);
    if (lastAttempt.ok) return { ...lastAttempt, extraRetries: 0 };
  }
  let extraRetries = 0;
  const retryStartedAt = clock();
  const retryWindowMs = Number(options.extraRetryWindowMs || 10_000);
  while (extraRetries < options.extraRetryMax && clock() - retryStartedAt <= retryWindowMs) {
    const egress = scheduler.chooseNext(clock(), attempted);
    if (!egress) break;
    attempted.add(egress.id);
    extraRetries += 1;
    const jitter = Number(options.retryJitterMs || 0);
    if (jitter > 0 && dependencies.sleep) await dependencies.sleep(Math.floor(Math.random() * jitter));
    lastAttempt = await runAttempt(options, dependencies, scheduler, egress, queue, extraRetries);
    if (lastAttempt.ok) return { ...lastAttempt, extraRetries };
  }
  return { ...(lastAttempt || probeAttempt || { ok: false, metadata: null }), extraRetries, collectorGap: true };
}

async function processQueue(queue, dependencies) {
  if (!queue) return [];
  const handler = dependencies.processObservation || (dependencies.engine ? async (body, item) => {
    return dependencies.engine.applyObservation(body, {
      observationId: item.observationId,
      observedAt: item.observedAt,
      receivedAt: item.receivedAt,
      rawPath: item.rawPath,
      payloadHash: item.payloadHash,
      bytes: item.bytes,
      statusCode: item.statusCode,
      durationMs: item.durationMs,
      error: item.error,
      parseStatus: item.parseStatus,
      egressId: item.egressId,
      egressGroup: item.egressGroup,
      retryNo: item.retryNo
    });
  } : null);
  if (!handler) return [];
  return queue.process(handler, { maxItems: dependencies.maxQueueItems || 8 });
}

async function runCollector(options, dependencies = {}) {
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const clock = dependencies.now || (() => Date.now());
  const egressPlan = options.egressPlan || loadEgressPlan(options);
  const scheduler = dependencies.scheduler || new EgressScheduler({
    statePath: options.stateFile,
    egresses: options.egresses || egressPlan.egresses,
    egressPlan,
    dailyBenchmark: options.dailyBenchmark,
    activePerGroup: options.activePerGroup,
    activeCount: options.activeCount,
    benchmarkRetryMs: options.benchmarkRetryMs,
    minIpIntervalMs: options.minIpIntervalMs
  });
  const queue = dependencies.queue || (options.queueDir ? new DurableObservationQueue(options.queueDir) : null);
  const recoveredQueueItems = queue?.recoverRawDirectory(options.outputDir) || 0;
  let polls = 0;
  let successes = 0;
  let failures = 0;
  let extraRetries = 0;
  let collectorGaps = 0;
  let nextPollAtMs = clock();
  while (clock() < options.untilMs) {
    const waitMs = Math.max(0, nextPollAtMs - clock());
    if (waitMs > 0) await sleep(waitMs);
    if (clock() >= options.untilMs) break;
    const businessDate = businessDateAt(clock());
    if (scheduler.needsDailyBenchmark?.(businessDate, clock())) {
      scheduler.prepareDailyBenchmark?.(businessDate, clock());
      const benchmark = await runEgressBenchmark(options, { ...dependencies, sleep }, scheduler, queue);
      await processQueue(queue, dependencies);
      if (benchmark.selectedIds.length === 0) {
        failures += 1;
        collectorGaps += 1;
        if (dependencies.onCollectorGap) await dependencies.onCollectorGap({
          type: 'egress_benchmark_failed',
          at: new Date(clock()).toISOString(),
          businessDate,
          candidates: benchmark.results.length
        });
        nextPollAtMs = clock() + Number(scheduler.benchmarkRetryMs || 5 * 60_000);
      } else {
        nextPollAtMs = scheduler.nextEligibleAt(clock());
      }
      if (options.once || clock() >= options.untilMs) break;
      continue;
    }
    polls += 1;
    const round = await runRound(options, { ...dependencies, sleep }, scheduler, queue);
    await processQueue(queue, dependencies);
    if (round.ok) successes += 1;
    else failures += 1;
    extraRetries += round.extraRetries || 0;
    if (round.collectorGap) {
      collectorGaps += 1;
      if (dependencies.onCollectorGap) await dependencies.onCollectorGap({ type: 'collector_gap', at: new Date(clock()).toISOString(), round: polls });
    }
    if (options.once || clock() >= options.untilMs) break;
    // Four exits can sustain a 15-second round cadence while each individual
    // address must remain idle for more than 30 seconds. Align the next round
    // to the first eligible exit so a millisecond boundary does not create a
    // false collector gap and skip the next valid poll.
    nextPollAtMs = Math.max(nextPollAtMs + options.intervalMs, scheduler.nextEligibleAt(clock()));
  }
  return {
    polls,
    successes,
    failures,
    extraRetries,
    collectorGaps,
    scheduler: scheduler.health(clock()),
    queue: queue?.status() || null,
    recoveredQueueItems,
    diskFreeBytes: diskFreeBytes(options.outputDir),
    stoppedAt: new Date(clock()).toISOString()
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  ensureDirectory(options.outputDir);
  // Production keeps projection in its own service. The opt-in embedded mode
  // is useful for a one-process local replay/probe and never changes the
  // collector's durable queue contract.
  const dependencies = process.env.PANEL_EMBED_PROJECTOR === '1'
    ? { engine: new ProjectionEngine({ minSteadyEntities: options.minSteadyEntities }) }
    : {};
  const result = await runCollector(options, { ...dependencies, onCollectorGap: event => console.error(JSON.stringify(event)) });
  console.log(JSON.stringify({ type: 'collector-finished', outputDir: options.outputDir, ...result }));
  return result.failures && !result.successes ? 1 : 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_ORIGIN,
  DEFAULT_PATH,
  DEFAULT_INTERVAL_MS,
  parseArgs,
  safeSnapshotSummary,
  persistObservation,
  collectOnce,
  businessDateAt,
  benchmarkSelection,
  runEgressBenchmark,
  runCollector,
  requestSnapshot,
  runRound,
  processQueue
};
