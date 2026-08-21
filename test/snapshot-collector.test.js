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

(async () => {
  const outputDir = tempDir();
  const options = parseArgs(['--once', '--output-dir', outputDir]);
  const result = await collectOnce(options, {
    now: () => 1_700_000_000_000,
    requestSnapshot: async () => ({ statusCode: 200, body: payload, durationMs: 12 })
  });
  assert.strictEqual(result.ok, true);
  const files = fs.readdirSync(outputDir).filter(file => file.endsWith('.json'));
  assert.strictEqual(files.length, 1);
  assert.deepStrictEqual(fs.readFileSync(path.join(outputDir, files[0])), payload);
  assert.strictEqual(fs.readFileSync(path.join(outputDir, 'manifest.jsonl'), 'utf8').trim().length > 0, true);

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
