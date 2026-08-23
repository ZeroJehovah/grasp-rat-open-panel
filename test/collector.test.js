'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectorHealth } = require('../collector/health');
const { EgressScheduler } = require('../collector/egress');
const { DurableObservationQueue } = require('../collector/queue');
const { collectOnce, parseArgs, runCollector, runRound } = require('../snapshot-collector');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'grasp-rat-egress-')); }
const egresses = [{ id: 'A1', group: 'A' }, { id: 'B1', group: 'B' }, { id: 'A2', group: 'A' }, { id: 'B2', group: 'B' }];

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

  const retryQueue = new DurableObservationQueue(path.join(root, 'retry-queue'));
  const retry = retryQueue.enqueue({ observationId: 'retry-me' }, Buffer.from('body'));
  const failedResult = await retryQueue.process(async () => { throw new Error('parse failed'); }, { maxAttempts: 1 });
  assert.ok(failedResult.some(item => item.item.observationId === 'retry-me' && item.status === 'failed'));
  assert.strictEqual(retryQueue.recoverFailed(Date.now() + 3_600_000), 1);
  assert.ok(retryQueue.pendingItems(Date.now() + 3_600_000).some(item => item.observationId === retry.observationId));

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
