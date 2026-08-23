'use strict';

const fs = require('fs');
const path = require('path');
const { ProjectionEngine } = require('../domain/projector');

function readManifest(directory) {
  const file = path.join(directory, 'manifest.jsonl');
  const byName = new Map();
  if (!fs.existsSync(file)) return byName;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.file) byName.set(item.file, item);
    } catch (_) { /* ignore a torn final manifest line; raw files remain authoritative */ }
  }
  return byName;
}

function listRawFiles(directory) {
  return fs.readdirSync(directory)
    .filter(file => file.endsWith('.json') && file !== 'manifest.jsonl')
    .map(file => path.join(directory, file))
    .sort();
}

function replayDirectory(directory, options = {}) {
  const root = path.resolve(directory);
  const manifest = readManifest(root);
  const engine = options.engine || new ProjectionEngine(options);
  let files = listRawFiles(root);
  if (options.limit) files = files.slice(0, Number(options.limit));
  let observations = 0;
  let projected = 0;
  let warmingUp = 0;
  let invalid = 0;
  let duplicates = 0;
  for (const filePath of files) {
    const file = path.basename(filePath);
    const metadata = manifest.get(file) || { observedAt: new Date(fs.statSync(filePath).mtimeMs).toISOString(), rawPath: filePath };
    const result = engine.applyObservation(fs.readFileSync(filePath), {
      observationId: metadata.observationId || `replay-${file}`,
      observedAt: metadata.observedAt,
      receivedAt: metadata.receivedAt,
      statusCode: metadata.statusCode || 200,
      durationMs: metadata.durationMs,
      bytes: metadata.bytes,
      payloadHash: metadata.payloadHash || metadata.sha256,
      rawPath: metadata.rawPath || filePath,
      egressId: metadata.egressId,
      egressGroup: metadata.egressGroup,
      retryNo: metadata.retryNo
    });
    observations += 1;
    if (result.status === 'projected') projected += 1;
    else if (result.status === 'warming_up') warmingUp += 1;
    else if (result.status === 'duplicate') duplicates += 1;
    else invalid += 1;
  }
  return {
    engine,
    files: files.length,
    observations,
    projected,
    warmingUp,
    invalid,
    duplicates,
    uniqueVersions: engine.versions.length,
    messages: engine.messages.size,
    kills: engine.kills.size,
    drops: engine.drops.size,
    rebuild: engine.verifyRebuild()
  };
}

module.exports = { replayDirectory, listRawFiles, readManifest };
