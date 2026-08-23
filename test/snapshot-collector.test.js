'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseArgs,
  safeSnapshotSummary,
  collectOnce,
  runCollector
} = require('../snapshot-collector');
const { DurableObservationQueue } = require('../collector/queue');
const { parseSnapshot } = require('../domain/snapshot');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grasp-rat-panel-'));
}

const payload = Buffer.from(JSON.stringify({
  type: 'snapshot',
  tick: 42,
  total_entities: 1,
  entities: [{ user_id: 7, name: 'test' }],
  bullets: [],
  coin_drops: [{ drop_id: 1 }],
  messages: []
}));

assert.strictEqual(parseArgs(['--until', '2026-08-22T06:00:00+08:00']).untilMs, Date.parse('2026-08-22T06:00:00+08:00'));
assert.deepStrictEqual(safeSnapshotSummary(payload), {
  validJson: true,
  type: 'snapshot',
  tick: 42,
  totalEntities: 1,
  entityCount: 1,
  bulletCount: 0,
  coinDropCount: 1,
  messageCount: 0,
  hasEntitiesArray: true
});
const emptySnapshot = Buffer.from(JSON.stringify({ type: 'snapshot', tick: 1, total_entities: 0, in_game: 0, visible: 0, occupied_cells: 0, entities: [], bullets: [], coin_drops: [], messages: [] }));
assert.strictEqual(parseSnapshot(emptySnapshot, { observedAt: '2026-08-22T00:00:00+08:00', minSteadyEntities: 0 }).completeness, 'steady');

(async () => {
  const outputDir = tempDir();
  const options = parseArgs(['--once', '--output-dir', outputDir, '--state-file', path.join(outputDir, 'collector-state.json'), '--queue-dir', path.join(outputDir, 'queue')]);
  const result = await collectOnce(options, {
    now: () => 1_700_000_000_000,
    requestSnapshot: async () => ({ statusCode: 200, body: payload, durationMs: 12 })
  });
  assert.strictEqual(result.ok, true);
  const files = fs.readdirSync(outputDir).filter(file => file.endsWith('.json'));
  assert.strictEqual(files.length, 1);
  assert.deepStrictEqual(fs.readFileSync(path.join(outputDir, files[0])), payload);
  assert.strictEqual(fs.readFileSync(path.join(outputDir, 'manifest.jsonl'), 'utf8').trim().length > 0, true);

  const invalidDir = tempDir();
  const invalidQueue = new DurableObservationQueue(path.join(invalidDir, 'queue'));
  const invalidBody = Buffer.from('not-json');
  const invalid = await collectOnce(parseArgs(['--once', '--output-dir', invalidDir]), {
    queue: invalidQueue,
    now: () => 1_700_000_000_100,
    requestSnapshot: async () => ({ statusCode: 200, body: invalidBody, durationMs: 3 })
  });
  assert.strictEqual(invalid.ok, false);
  assert.deepStrictEqual(fs.readFileSync(path.join(invalidDir, fs.readdirSync(invalidDir).find(file => file.endsWith('.bin')))), invalidBody);
  assert.strictEqual(invalidQueue.status().pending, 1);

  const failedDir = tempDir();
  const failedQueue = new DurableObservationQueue(path.join(failedDir, 'queue'));
  const failed = await collectOnce(parseArgs(['--once', '--output-dir', failedDir]), {
    queue: failedQueue,
    now: () => 1_700_000_000_200,
    requestSnapshot: async () => ({ statusCode: 403, body: Buffer.from('captcha'), durationMs: 4 })
  });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(fs.readdirSync(failedDir).filter(file => file !== 'manifest.jsonl').length, 1);
  assert.strictEqual(failedQueue.status().pending, 1);

  let now = 0;
  let calls = 0;
  const run = await runCollector({ ...options, once: false, untilMs: 61_000, intervalMs: 30_000 }, {
    now: () => now,
    sleep: async ms => { now += ms; },
    requestSnapshot: async () => { calls += 1; return { statusCode: 200, body: payload, durationMs: 1 }; }
  });
  assert.strictEqual(calls, 3);
  assert.strictEqual(run.successes, 3);
  console.log('snapshot collector tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
