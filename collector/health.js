'use strict';

const fs = require('fs');
const path = require('path');
const { loadEgressPlan } = require('./egress');

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

function rawRetentionBacklog(directory, now = Date.now()) {
  let count = 0;
  let bytes = 0;
  const cutoff = now - 24 * 60 * 60 * 1000;
  const observedAtByFile = new Map();
  try {
    const manifestPath = path.join(directory, 'manifest.jsonl');
    if (fs.existsSync(manifestPath)) {
      for (const line of fs.readFileSync(manifestPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          const file = typeof record.file === 'string' ? path.basename(record.file) : '';
          const observedAt = Date.parse(record.observedAt || record.observed_at || '');
          if (file && record.storedAsSnapshot !== false && Number.isFinite(observedAt)) observedAtByFile.set(file, observedAt);
        } catch (_) { /* a partial manifest line must not break health reporting */ }
      }
    }
    for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.json') || name.endsWith('.bin'))) {
      const filePath = path.join(directory, file);
      const stat = fs.statSync(filePath);
      const observedAt = observedAtByFile.get(file);
      if ((Number.isFinite(observedAt) ? observedAt : stat.mtimeMs) < cutoff) {
        count += 1;
        bytes += Number(stat.size || 0);
      }
    }
  } catch (_) { /* the disk/queue checks remain useful during a directory race */ }
  return { count, bytes };
}

function collectorHealth(options = {}) {
  const now = options.now || Date.now();
  const statePath = options.stateFile || process.env.GRASP_RAT_PANEL_STATE_FILE || path.resolve(__dirname, '../../data/collector-state.json');
  const queueDir = options.queueDir || process.env.GRASP_RAT_PANEL_QUEUE_DIR || path.resolve(__dirname, '../../data/spool');
  const rawDir = options.rawDir || process.env.GRASP_RAT_PANEL_SNAPSHOT_DIR || path.resolve(__dirname, '../../data/raw-snapshots');
  const state = readState(statePath) || { egresses: {}, consecutiveFailures: 0 };
  const egressPlan = loadEgressPlan({
    ...options,
    egressConfigPath: options.egressConfigPath || process.env.GRASP_RAT_PANEL_EGRESS_CONFIG
  });
  const egresses = egressPlan.egresses;
  const runtimePool = egressPlan.dailyBenchmark && Array.isArray(state.runtimeActiveEgressIds)
    ? new Set(state.runtimeActiveEgressIds)
    : new Set(egresses.map(egress => egress.id));
  let latestSuccessAt = null;
  let availableA = 0;
  let availableB = 0;
  let cooling = 0;
  let probes = 0;
  for (const egress of egresses) {
    const item = state.egresses?.[egress.id] || {};
    const successAtMs = typeof item.last_success_at === 'number'
      ? item.last_success_at
      : Date.parse(item.last_success_at || '');
    if (Number.isFinite(successAtMs) && (!latestSuccessAt || successAtMs > latestSuccessAt)) latestSuccessAt = successAtMs;
    if (Number(item.cooldown_until || 0) > now) cooling += 1;
    else if (item.probe_required) probes += 1;
    else if (runtimePool.has(egress.id) && Number(item.next_eligible_at || 0) <= now) egress.group === 'A' ? availableA += 1 : availableB += 1;
  }
  const count = directory => { try { return fs.readdirSync(directory).filter(file => file.endsWith('.body')).length; } catch (_) { return 0; } };
  const rawBacklog = rawRetentionBacklog(rawDir, now);
  return {
    latestSuccessVersionAgeMs: latestSuccessAt ? Math.max(0, now - latestSuccessAt) : null,
    latestSuccessAt: latestSuccessAt ? new Date(latestSuccessAt).toISOString() : null,
    queueDepth: count(path.join(queueDir, 'pending')),
    availableEgressGroups: { A: availableA, B: availableB },
    coolingEgressCount: cooling,
    healthProbeEgressCount: probes,
    consecutiveFailures: Number(state.consecutiveFailures || 0),
    diskFreeBytes: diskFreeBytes(rawDir),
    rawRetentionBacklogCount: rawBacklog.count,
    rawRetentionBacklogBytes: rawBacklog.bytes,
    dailyBenchmark: egressPlan.dailyBenchmark,
    candidateEgressCount: egresses.length,
    activeEgressIds: state.activeEgressIds || [],
    runtimeActiveEgressIds: Array.from(runtimePool),
    selectionBusinessDate: state.selectionBusinessDate || null
  };
}

module.exports = { diskFreeBytes, rawRetentionBacklog, collectorHealth };
