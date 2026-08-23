'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DurableObservationQueue } = require('../collector/queue');
const { runRetention } = require('../commands/retention');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'grasp-rat-retention-')); }

(async () => {
  const root = tempDir();
  const rawDir = path.join(root, 'raw');
  const queueDir = path.join(root, 'queue');
  fs.mkdirSync(rawDir, { recursive: true });
  const oldAt = '2026-08-21T00:00:00.000Z';
  const rawPath = path.join(rawDir, 'old.json');
  fs.writeFileSync(rawPath, 'raw-body');
  fs.writeFileSync(path.join(rawDir, 'manifest.jsonl'), `${JSON.stringify({ observationId: 'old-observation', observedAt: oldAt, file: 'old.json', rawPath, storedAsSnapshot: true, parseStatus: 'pending' })}\n`);
  const queue = new DurableObservationQueue(queueDir);
  queue.enqueue({ observationId: 'old-observation', rawPath, parseStatus: 'pending' }, Buffer.from('raw-body'));
  await queue.process(async () => ({ status: 'projected' }));
  // Exercise retention's legacy/repair path as well: a body may remain if a
  // prior process stopped after committing metadata but before cleanup.
  fs.writeFileSync(path.join(queueDir, 'processed', 'old-observation.body'), 'stale-body');
  const result = runRetention({ rawDir, queueDir, rawHours: 24, metadataDays: 62, now: new Date('2026-08-23T00:00:00Z'), dryRun: false });
  assert.strictEqual(result.deleted, 1);
  assert.strictEqual(result.processedBodiesDeleted, 1);
  assert.strictEqual(fs.existsSync(rawPath), false);
  assert.strictEqual(fs.existsSync(path.join(queueDir, 'processed', 'old-observation.body')), false);

  const gatedRoot = tempDir();
  const gatedRawDir = path.join(gatedRoot, 'raw');
  const gatedQueueDir = path.join(gatedRoot, 'queue');
  fs.mkdirSync(gatedRawDir, { recursive: true });
  fs.writeFileSync(path.join(gatedRawDir, 'manifest.jsonl'), `${JSON.stringify({ observationId: 'gated-observation', observedAt: oldAt, file: 'old.json', storedAsSnapshot: true, parseStatus: 'projected' })}\n`);
  fs.writeFileSync(path.join(gatedRawDir, 'old.json'), 'raw-body');
  const gated = runRetention({ rawDir: gatedRawDir, queueDir: gatedQueueDir, rawHours: 24, metadataDays: 62, now: new Date('2026-08-23T00:00:00Z'), dryRun: false, allowRawDeletion: false });
  assert.strictEqual(gated.rawDeletionAllowed, false);
  assert.strictEqual(gated.deleted, 0);
  assert.strictEqual(fs.existsSync(path.join(gatedRawDir, 'old.json')), true);
  console.log('retention tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
