#!/usr/bin/env node
'use strict';

const path = require('path');
const { replayDirectory } = require('../storage/replay');

const directory = process.argv[2] || path.resolve(__dirname, '../../data/raw-snapshots');
const result = replayDirectory(directory, { minSteadyEntities: Number(process.env.PANEL_MIN_STEADY_ENTITIES || 900) });
console.log(JSON.stringify({
  type: 'snapshot-replay-finished',
  directory,
  files: result.files,
  observations: result.observations,
  projected: result.projected,
  warmingUp: result.warmingUp,
  invalid: result.invalid,
  duplicates: result.duplicates,
  uniqueVersions: result.uniqueVersions,
  messages: result.messages,
  kills: result.kills,
  drops: result.drops,
  rebuild: result.rebuild
}, null, 2));
if (!result.rebuild.ok) process.exitCode = 1;
