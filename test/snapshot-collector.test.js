'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseArgs,
  safeSnapshotSummary,
  persistObservation,
  collectOnce,
  runCollector
} = require('../snapshot-collector');
const { DurableObservationQueue } = require('../collector/queue');
const { listRawSnapshots } = require('../collector/raw-retention');
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

  const retainedDir = tempDir();
  const retainedQueue = new DurableObservationQueue(path.join(retainedDir, 'queue'));
  const retainedOptions = parseArgs(['--once', '--output-dir', retainedDir, '--state-file', path.join(retainedDir, 'state.json')]);
  fs.writeFileSync(path.join(retainedDir, 'settings.json'), '{}');
  fs.writeFileSync(path.join(retainedDir, '20230101T000000000Z-incomplete.json.tmp'), 'partial');
  const nestedDirectory = path.join(retainedDir, '20230101T000000000Z-directory.json');
  fs.mkdirSync(nestedDirectory);
  fs.writeFileSync(path.join(nestedDirectory, 'keep.json'), 'keep');
  const linkedFile = path.join(retainedDir, '20230101T000000000Z-link.json');
  fs.symlinkSync(path.join(retainedDir, 'settings.json'), linkedFile);
  const observations = [];
  const bodies = new Map();
  let retainedNow = 1_700_000_000_000;
  for (let index = 0; index < 25; index += 1) {
    // Include invalid 2xx audit bodies and identical versions in the same limit.
    const body = index === 1 || index === 24 ? invalidBody : payload;
    const collected = await collectOnce(retainedOptions, {
      queue: retainedQueue,
      now: () => retainedNow,
      requestSnapshot: async () => ({ statusCode: 200, body, durationMs: 1 })
    });
    observations.push(collected.metadata);
    bodies.set(collected.metadata.observationId, body);
    assert.deepStrictEqual(listRawSnapshots(retainedDir).sort(), observations.slice(-20).map(item => item.file).sort());
    assert.deepStrictEqual(fs.readFileSync(collected.metadata.rawPath), body);
    if (index === 0) fs.utimesSync(collected.metadata.rawPath, new Date('2099-01-01'), new Date('2099-01-01'));
    retainedNow += 15_000;
  }
  assert.strictEqual(fs.existsSync(observations[0].rawPath), false, 'retention must use observation time, not mtime');
  assert.strictEqual(fs.existsSync(observations[1].rawPath), false, 'old .bin audit bodies must be removed too');
  assert.strictEqual(fs.readFileSync(path.join(retainedDir, 'settings.json'), 'utf8'), '{}');
  assert.strictEqual(fs.readFileSync(path.join(retainedDir, '20230101T000000000Z-incomplete.json.tmp'), 'utf8'), 'partial');
  assert.strictEqual(fs.readFileSync(path.join(nestedDirectory, 'keep.json'), 'utf8'), 'keep');
  assert.ok(fs.lstatSync(linkedFile).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(path.join(retainedDir, 'manifest.jsonl'), 'utf8').trim().split('\n').length, 25);

  const orphan = persistObservation({ statusCode: 200, body: payload }, retainedOptions, new Date(retainedNow));
  bodies.set(orphan.observationId, payload);
  retainedNow += 15_000;
  for (const requestSnapshot of [
    async () => ({ statusCode: 503, body: Buffer.from('unavailable') }),
    async () => { throw new Error('timeout'); }
  ]) {
    const failure = await collectOnce(retainedOptions, { queue: retainedQueue, now: () => retainedNow, requestSnapshot });
    assert.strictEqual(failure.ok, false);
    assert.strictEqual(listRawSnapshots(retainedDir).length, 21, 'failed requests must not prune existing raw files');
  }

  const restarted = await runCollector(retainedOptions, {
    queue: retainedQueue,
    now: () => retainedNow,
    requestSnapshot: async () => ({ statusCode: 200, body: payload })
  });
  assert.strictEqual(restarted.recoveredQueueItems, 1, 'startup must recover a body written before enqueue');
  assert.strictEqual(restarted.successes, 1);
  assert.strictEqual(listRawSnapshots(retainedDir).length, 20, 'scheduled collection must enforce the same limit');
  const projected = await retainedQueue.process(async (body, item) => {
    assert.deepStrictEqual(body, bodies.get(item.observationId) || (item.storedAsSnapshot ? payload : Buffer.alloc(0)));
    return { status: item.validSnapshot ? 'projected' : 'invalid' };
  });
  assert.strictEqual(projected.length, 29);
  assert.ok(projected.every(item => item.status === 'processed'), 'pruning must not lose any queued body');

  const blockedPath = path.join(retainedDir, listRawSnapshots(retainedDir).at(-1));
  const unlinkSync = fs.unlinkSync;
  try {
    fs.unlinkSync = filePath => {
      if (filePath === blockedPath) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return unlinkSync(filePath);
    };
    retainedNow += 15_000;
    const cleanupFailed = await collectOnce(retainedOptions, {
      queue: retainedQueue,
      now: () => retainedNow,
      requestSnapshot: async () => ({ statusCode: 200, body: payload })
    });
    assert.strictEqual(cleanupFailed.ok, true, 'cleanup errors must not turn a saved observation into a request failure');
    assert.strictEqual(cleanupFailed.metadata.parseStatus, 'pending');
    assert.strictEqual(retainedQueue.status().pending, 1);
    assert.strictEqual(listRawSnapshots(retainedDir).length, 21);
  } finally {
    fs.unlinkSync = unlinkSync;
  }
  retainedNow += 15_000;
  await collectOnce(retainedOptions, {
    queue: retainedQueue,
    now: () => retainedNow,
    requestSnapshot: async () => ({ statusCode: 200, body: payload })
  });
  assert.strictEqual(listRawSnapshots(retainedDir).length, 20, 'next successful response must retry cleanup');
  assert.strictEqual(fs.existsSync(blockedPath), false);

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
