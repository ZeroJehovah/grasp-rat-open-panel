'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectorHealth } = require('../collector/health');
const { EgressScheduler } = require('../collector/egress');
const { DurableObservationQueue } = require('../collector/queue');
const { collectOnce, parseArgs, runCollector, runRound, benchmarkSelection } = require('../snapshot-collector');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'grasp-rat-egress-')); }
const egresses = [{ id: 'A1', group: 'A' }, { id: 'B1', group: 'B' }, { id: 'A2', group: 'A' }, { id: 'B2', group: 'B' }];

(() => {
  const candidates = [
    { id: 'A1', group: 'A' }, { id: 'B1', group: 'B' },
    { id: 'A2', group: 'A' }, { id: 'B2', group: 'B' },
    { id: 'A3', group: 'A' }, { id: 'B3', group: 'B' }
  ];
  const scheduler = new EgressScheduler({
    statePath: path.join(tempDir(), 'state.json'),
    egresses: candidates,
    egressPlan: { dailyBenchmark: true, selection: { mode: 'daily-fastest', activePerGroup: 2, activeCount: 4 } }
  });
  const benchmark = candidates.map(egress => ({
    id: egress.id,
    group: egress.group,
    durationMs: { A1: 40, A2: 10, A3: 20, B1: 30, B2: 5, B3: 15 }[egress.id],
    success: true,
    statusCode: 200,
    validSnapshot: true,
    bytes: 1
  }));
  assert.deepStrictEqual(benchmarkSelection(benchmark, scheduler), ['A2', 'A3', 'B2', 'B3']);
  scheduler.setDailySelection('2026-08-23', ['A2', 'A3', 'B2', 'B3'], 0, benchmark);
  const failed = candidates.find(egress => egress.id === 'A2');
  scheduler.markAttempt(failed, 1);
  scheduler.markResult(failed, { statusCode: 403, body: Buffer.from('forbidden') }, 2);
  assert.ok(scheduler.runtimePoolIds().has('A1'), 'failed active egress should be replaced from the candidate pool');
  assert.ok(!scheduler.runtimePoolIds().has('A2'));
  const probeAt = scheduler.stateFor(failed).cooldown_until + 1;
  assert.strictEqual(scheduler.chooseProbe(probeAt).id, 'A2', 'a cooled inactive egress should receive a health probe');
  scheduler.markAttempt(failed, probeAt);
  scheduler.markResult(failed, { statusCode: 200, body: Buffer.from('{}'), payloadHash: 'probe-ok' }, probeAt + 1);
  assert.strictEqual(scheduler.stateFor(failed).probe_required, false);
  assert.ok(scheduler.runtimePoolIds().has('A2'), 'a recovered selected egress should reclaim its active slot');
  assert.ok(!scheduler.runtimePoolIds().has('A1'), 'temporary replacement should leave after probe recovery');
  const inactive = candidates.find(egress => egress.id === 'A1');
  const inactiveState = scheduler.stateFor(inactive);
  inactiveState.probe_required = true;
  inactiveState.cooldown_until = 0;
  inactiveState.next_eligible_at = 0;
  assert.strictEqual(scheduler.chooseProbe(0).id, 'A1', 'inactive benchmark candidates should also be probeable');
  scheduler.markAttempt(inactive, 0);
  scheduler.markResult(inactive, { statusCode: 200, body: Buffer.from('{}'), payloadHash: 'inactive-probe-ok' }, 1);
  assert.strictEqual(inactiveState.probe_required, false);
  assert.deepStrictEqual([...scheduler.runtimePoolIds()].sort(), ['A2', 'A3', 'B2', 'B3']);
  console.log('daily egress benchmark and runtime rotation tests passed');
})();

(() => {
  const statePath = path.join(tempDir(), 'state.json');
  const scheduler = new EgressScheduler({ statePath, egresses });
  const first = scheduler.choose('A', 0);
  assert.strictEqual(first.id, 'A1');
  scheduler.markAttempt(first, 0);
  assert.strictEqual(scheduler.choose('A', 0).id, 'A2');
  scheduler.markResult(first, { statusCode: 429, body: Buffer.from('rate limited') }, 0);
  assert.ok(scheduler.stateFor(first).cooldown_until > 0);
  assert.strictEqual(scheduler.choose('A', 1_000).id, 'A2');
  assert.ok(scheduler.stateFor(first).next_eligible_at > 30_000);
})();

(async () => {
  const root = tempDir();
  const queue = new DurableObservationQueue(path.join(root, 'queue'));
  const outputDir = path.join(root, 'raw');
  fs.mkdirSync(outputDir, { recursive: true });
  const options = parseArgs(['--once', '--output-dir', outputDir]);
  const failed = await collectOnce(options, {
    queue,
    requestSnapshot: async () => { throw Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }); }
  });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(queue.status().pending, 1);

  const moved = queue.enqueue({ observationId: 'partial-processed' }, Buffer.from('body'));
  fs.renameSync(moved.bodyPath, path.join(queue.processed, path.basename(moved.bodyPath)));
  const restarted = new DurableObservationQueue(queue.root);
  restarted.recoverPartialMoves();
  assert.strictEqual(restarted.status().processed, 1);
  assert.strictEqual(restarted.status().pending, 1);

  const failedMove = queue.enqueue({ observationId: 'partial-failed' }, Buffer.from('body'));
  const failedMetadataPath = failedMove.bodyPath.replace(/\.body$/, '.json');
  fs.renameSync(failedMetadataPath, path.join(queue.failed, path.basename(failedMetadataPath)));
  const recovered = new DurableObservationQueue(queue.root);
  recovered.recoverPartialMoves();
  assert.ok(recovered.pendingItems().some(item => item.observationId === 'partial-failed'));

  const metadataFirst = queue.enqueue({ observationId: 'metadata-first' }, Buffer.from('body'));
  const metadataFirstPath = metadataFirst.bodyPath.replace(/\.body$/, '.json');
  fs.renameSync(metadataFirstPath, path.join(queue.processed, path.basename(metadataFirstPath)));
  const metadataFirstRecovered = new DurableObservationQueue(queue.root);
  metadataFirstRecovered.recoverPartialMoves();
  assert.ok(metadataFirstRecovered.pendingItems().some(item => item.observationId === 'metadata-first'));

  const retryQueue = new DurableObservationQueue(path.join(root, 'retry-queue'));
  const retry = retryQueue.enqueue({ observationId: 'retry-me' }, Buffer.from('body'));
  const failedResult = await retryQueue.process(async () => { throw new Error('parse failed'); }, { maxAttempts: 1 });
  assert.ok(failedResult.some(item => item.item.observationId === 'retry-me' && item.status === 'failed'));
  assert.strictEqual(retryQueue.recoverFailed(Date.now() + 3_600_000), 1);
  assert.ok(retryQueue.pendingItems(Date.now() + 3_600_000).some(item => item.observationId === retry.observationId));

  const compactQueue = new DurableObservationQueue(path.join(root, 'compact-queue'));
  const compact = compactQueue.enqueue({ observationId: 'compact-me' }, Buffer.from('body'));
  await compactQueue.process(async () => ({ status: 'projected' }));
  assert.strictEqual(fs.existsSync(path.join(compactQueue.processed, 'compact-me.body')), false);
  assert.strictEqual(fs.existsSync(path.join(compactQueue.processed, 'compact-me.json')), true);

  const statePath = path.join(root, 'state.json');
  const healthNow = Date.now();
  fs.writeFileSync(statePath, JSON.stringify({ consecutiveFailures: 2, egresses: {
    A1: { last_success_at: '2026-08-22T00:00:00Z', cooldown_until: 0, next_eligible_at: 0, probe_required: true },
    A2: { last_success_at: null, cooldown_until: healthNow + 10_000, next_eligible_at: 0, probe_required: false },
    B1: { last_success_at: null, cooldown_until: 0, next_eligible_at: 0, probe_required: false },
    B2: { last_success_at: null, cooldown_until: 0, next_eligible_at: healthNow + 1_000_000, probe_required: false }
  } }));
  const health = collectorHealth({ stateFile: statePath, queueDir: queue.root, rawDir: outputDir, egresses });
  assert.strictEqual(health.healthProbeEgressCount, 1);
  assert.deepStrictEqual(health.availableEgressGroups, { A: 0, B: 1 });
  const configPath = path.join(root, 'egresses.json');
  fs.writeFileSync(configPath, JSON.stringify([{ id: 'A-custom', group: 'A' }, { id: 'B-custom', group: 'B' }]));
  const configuredHealth = collectorHealth({ stateFile: statePath, queueDir: queue.root, rawDir: outputDir, egressConfigPath: configPath });
  assert.deepStrictEqual(configuredHealth.availableEgressGroups, { A: 1, B: 1 });
  console.log('queue recovery and health tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
  const outputDir = tempDir();
  const scheduler = new EgressScheduler({ statePath: path.join(outputDir, 'state.json'), egresses });
  let now = 0;
  let calls = 0;
  const limited = await runRound({ outputDir, extraRetryMax: 3, extraRetryWindowMs: 5_000, retryJitterMs: 0 }, {
    now: () => now,
    requestSnapshot: async () => { calls += 1; now += calls === 3 ? 6_000 : 100; return { statusCode: 502, body: Buffer.from('bad gateway'), durationMs: 1 }; }
  }, scheduler, null);
  assert.strictEqual(limited.collectorGap, true);
  assert.strictEqual(limited.extraRetries, 1);
  assert.strictEqual(calls, 3);

  const gapEvents = [];
  const collected = await runCollector({ outputDir: tempDir(), stateFile: path.join(tempDir(), 'state.json'), untilMs: 1, once: true, intervalMs: 15_000, extraRetryMax: 0 }, {
    now: () => 0,
    requestSnapshot: async () => ({ statusCode: 502, body: Buffer.from('bad gateway'), durationMs: 1 }),
    onCollectorGap: event => gapEvents.push(event)
  });
  assert.strictEqual(collected.collectorGaps, 1);
  assert.strictEqual(gapEvents[0].type, 'collector_gap');
  console.log('retry window and gap tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(() => {
  const statePath = path.join(tempDir(), 'state.json');
  const scheduler = new EgressScheduler({ statePath, egresses, minIpIntervalMs: 1, cooldownMs: 100, maxCooldownMs: 100 });
  const first = scheduler.choose('A', 0);
  scheduler.markAttempt(first, 0);
  scheduler.markResult(first, { statusCode: 429, body: Buffer.from('rate limited') }, 0);
  assert.strictEqual(scheduler.choose('A', 50, new Set(['A2'])), null);
  const probe = scheduler.choose('A', 100, new Set(['A2']));
  assert.strictEqual(probe.id, first.id);
  scheduler.markAttempt(probe, 100);
  assert.strictEqual(scheduler.stateFor(probe).probe_in_flight, true);
  scheduler.markResult(probe, { statusCode: 200, body: Buffer.from('{}'), payloadHash: 'ok' }, 101);
  assert.strictEqual(scheduler.stateFor(probe).probe_required, false);
})();

(async () => {
  const outputDir = tempDir();
  const scheduler = new EgressScheduler({ statePath: path.join(outputDir, 'state.json'), egresses });
  for (const egress of egresses) scheduler.stateFor(egress).cooldown_until = 10_000;
  const result = await runRound({ outputDir, extraRetryMax: 0 }, {
    now: () => 0,
    requestSnapshot: async () => { throw new Error('no egress should be selected'); }
  }, scheduler, null);
  assert.strictEqual(result.collectorGap, true);
  console.log('unavailable egress gap test passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
  const outputDir = tempDir();
  const scheduler = new EgressScheduler({ statePath: path.join(outputDir, 'state.json'), egresses });
  const calls = [];
  const payload = Buffer.from(JSON.stringify({ type: 'snapshot', tick: 1, total_entities: 0, entities: [], bullets: [], coin_drops: [], messages: [] }));
  const result = await runRound({ outputDir, extraRetryMax: 1, retryJitterMs: 0 }, {
    now: () => 0,
    requestSnapshot: async (_options, _clock, egress) => {
      calls.push(egress.id);
      if (calls.length < 3) return { statusCode: 502, body: Buffer.from('bad gateway'), durationMs: 1 };
      return { statusCode: 200, body: payload, durationMs: 1 };
    }
  }, scheduler, null);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(calls, ['A1', 'B1', 'A2']);
  console.log('collector tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
  const outputDir = tempDir();
  const scheduler = new EgressScheduler({ statePath: path.join(outputDir, 'state.json'), egresses, minIpIntervalMs: 30_001 });
  const payload = Buffer.from(JSON.stringify({ type: 'snapshot', tick: 1, total_entities: 0, in_game: 0, visible: 0, occupied_cells: 0, entities: [], bullets: [], coin_drops: [], messages: [] }));
  let now = 0;
  const calls = [];
  const result = await runCollector({ outputDir, stateFile: path.join(outputDir, 'state.json'), untilMs: 75_002, once: false, intervalMs: 15_000, extraRetryMax: 0, retryJitterMs: 0 }, {
    scheduler,
    now: () => now,
    sleep: async milliseconds => { now += milliseconds; },
    requestSnapshot: async (_options, clock, egress) => {
      calls.push({ id: egress.id, at: clock() });
      return { statusCode: 200, body: payload, durationMs: 1 };
    }
  });
  assert.strictEqual(result.collectorGaps, 0);
  assert.deepStrictEqual(calls.map(call => call.id), ['A1', 'B1', 'A2', 'B2', 'A1', 'B1']);
  for (const id of ['A1', 'B1', 'A2', 'B2']) {
    const times = calls.filter(call => call.id === id).map(call => call.at);
    for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] > 30_000);
  }
  console.log('collector cadence tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
