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
  const result = runRetention({ rawDir, queueDir, rawHours: 24, metadataDays: 62, now: new Date('2026-08-23T00:00:00Z'), dryRun: false });
  assert.strictEqual(result.deleted, 1);
  assert.strictEqual(result.processedBodiesDeleted, 1);
  assert.strictEqual(fs.existsSync(rawPath), false);
  assert.strictEqual(fs.existsSync(path.join(queueDir, 'processed', 'old-observation.body')), false);
  console.log('retention tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
