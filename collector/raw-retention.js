'use strict';

const fs = require('fs');
const path = require('path');

const RAW_SNAPSHOT_LIMIT = 20;

function listRawSnapshots(directory) {
  // Collector filenames start with a sortable UTC observation timestamp.
  // Ignore manifests, scheduler state, temporary files and directory entries.
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^\d{8}T\d{9}Z-.+\.(json|bin)$/.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .reverse();
}

function pruneRawSnapshots(directory) {
  const result = { keep: RAW_SNAPSHOT_LIMIT, eligible: 0, deleted: 0, deletedBytes: 0, errors: [] };
  let expired;
  try {
    expired = listRawSnapshots(directory).slice(RAW_SNAPSHOT_LIMIT);
  } catch (error) {
    result.errors.push({ code: error.code || 'UNKNOWN' });
    return result;
  }
  result.eligible = expired.length;
  for (const file of expired) {
    try {
      const filePath = path.join(directory, file);
      const size = fs.statSync(filePath).size;
      fs.unlinkSync(filePath);
      result.deleted += 1;
      result.deletedBytes += size;
    } catch (error) {
      if (error.code !== 'ENOENT') result.errors.push({ file, code: error.code || 'UNKNOWN' });
    }
  }
  return result;
}

module.exports = { RAW_SNAPSHOT_LIMIT, listRawSnapshots, pruneRawSnapshots };
