'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listBackfillItems, parseArgs, runBackfill } = require('../commands/backfill-postgres');

assert.throws(() => parseArgs([]), /--from and --to are required/);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grasp-rat-backfill-'));
const file = '20260821T122709Z-fixture.json';
fs.writeFileSync(path.join(root, file), '{}');
fs.writeFileSync(path.join(root, 'manifest.jsonl'), `${JSON.stringify({ file, observedAt: '2026-08-21T12:27:09.399Z', statusCode: 200 })}\n`);
const options = parseArgs(['--raw-dir', root, '--from', '2026-08-21', '--to', '2026-08-21']);
assert.strictEqual(listBackfillItems(options).length, 1);

(async () => {
  const result = await runBackfill({ ...options, dryRun: true });
  assert.deepStrictEqual({ files: result.files, from: result.from, to: result.to, dryRun: result.dryRun }, { files: 1, from: '2026-08-21', to: '2026-08-21', dryRun: true });
  fs.rmSync(root, { recursive: true, force: true });
  console.log('backfill tests passed');
})().catch(error => { fs.rmSync(root, { recursive: true, force: true }); console.error(error); process.exitCode = 1; });
