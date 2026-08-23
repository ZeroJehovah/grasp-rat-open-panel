'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EgressScheduler } = require('../collector/egress');
const { runRound } = require('../snapshot-collector');

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
