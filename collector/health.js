'use strict';

const fs = require('fs');
const path = require('path');
const { loadEgresses } = require('./egress');

function diskFreeBytes(directory) {
  try {
    const stats = fs.statfsSync(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (_) {
    return null;
  }
}

function readState(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function collectorHealth(options = {}) {
  const now = Date.now();
  const statePath = options.stateFile || process.env.GRASP_RAT_PANEL_STATE_FILE || path.resolve(__dirname, '../../data/collector-state.json');
  const queueDir = options.queueDir || process.env.GRASP_RAT_PANEL_QUEUE_DIR || path.resolve(__dirname, '../../data/spool');
  const rawDir = options.rawDir || process.env.GRASP_RAT_PANEL_SNAPSHOT_DIR || path.resolve(__dirname, '../../data/raw-snapshots');
  const state = readState(statePath) || { egresses: {}, consecutiveFailures: 0 };
  const egresses = loadEgresses(options);
  let latestSuccessAt = null;
  let availableA = 0;
  let availableB = 0;
  let cooling = 0;
  let probes = 0;
  for (const egress of egresses) {
    const item = state.egresses?.[egress.id] || {};
    if (item.last_success_at && (!latestSuccessAt || item.last_success_at > latestSuccessAt)) latestSuccessAt = item.last_success_at;
    if (Number(item.cooldown_until || 0) > now) cooling += 1;
    else if (item.probe_required) probes += 1;
    else if (Number(item.next_eligible_at || 0) <= now) egress.group === 'A' ? availableA += 1 : availableB += 1;
  }
  const count = directory => { try { return fs.readdirSync(directory).filter(file => file.endsWith('.body')).length; } catch (_) { return 0; } };
  return {
    latestSuccessVersionAgeMs: latestSuccessAt ? Math.max(0, now - Date.parse(latestSuccessAt)) : null,
    latestSuccessAt,
    queueDepth: count(path.join(queueDir, 'pending')),
    availableEgressGroups: { A: availableA, B: availableB },
    coolingEgressCount: cooling,
    healthProbeEgressCount: probes,
    consecutiveFailures: Number(state.consecutiveFailures || 0),
    diskFreeBytes: diskFreeBytes(rawDir)
  };
}

module.exports = { diskFreeBytes, collectorHealth };
