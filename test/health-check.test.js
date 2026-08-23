'use strict';

const assert = require('assert');
const { evaluateHealth, fetchJsonWithRetry } = require('../commands/health-check');

const now = new Date('2026-08-23T00:00:00.000Z');
const healthy = evaluateHealth({
  now,
  collector: {
    latestSuccessVersionAgeMs: 1_000,
    queueDepth: 2,
    diskFreeBytes: 10 * 1024 * 1024 * 1024,
    consecutiveFailures: 0,
    availableEgressGroups: { A: 1, B: 1 },
    healthProbeEgressCount: 0
  },
  database: { configured: true, ok: true, latestAgeMs: 2_000, versionGapMs: 30_000 },
  api: { ok: true },
  options: { maxLatestSuccessAgeMs: 300_000, maxVersionGapMs: 300_000, minDiskFreeBytes: 5 * 1024 * 1024 * 1024, maxQueueDepth: 100, maxConsecutiveFailures: 2 }
});
assert.strictEqual(healthy.ok, true);

const unhealthy = evaluateHealth({
  now,
  collector: {
    latestSuccessVersionAgeMs: 400_000,
    queueDepth: 101,
    diskFreeBytes: 1,
    consecutiveFailures: 3,
    availableEgressGroups: { A: 0, B: 1 },
    healthProbeEgressCount: 1,
    rawRetentionBacklogCount: 4
  },
  database: { configured: true, ok: true, latestAgeMs: 400_000, versionGapMs: 400_000 },
  api: { ok: false, statusCode: 503 },
  options: { maxLatestSuccessAgeMs: 300_000, maxVersionGapMs: 300_000, minDiskFreeBytes: 5, maxQueueDepth: 100, maxConsecutiveFailures: 2 }
});
assert.strictEqual(unhealthy.ok, false);
assert.deepStrictEqual(unhealthy.failures, ['collector_stale', 'queue_backlog', 'disk_low', 'collector_failures', 'database_stale', 'version_gap', 'api_unhealthy']);
assert.deepStrictEqual(unhealthy.warnings, ['egress_group_unavailable', 'egress_probe_required', 'raw_retention_backlog']);

(async () => {
  let attempts = 0;
  const response = await fetchJsonWithRetry('http://127.0.0.1:19317/healthz', 5, 2, 0, async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    return { statusCode: 200, payload: { ok: true } };
  });
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(attempts, 2);
  console.log('health check tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
