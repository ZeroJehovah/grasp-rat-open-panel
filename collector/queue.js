'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function ensure(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function syncDirectory(directory) {
  try {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (_) { /* some filesystems do not allow directory fsync */ }
}

function durableRename(source, target) {
  fs.renameSync(source, target);
  syncDirectory(path.dirname(source));
  if (path.dirname(source) !== path.dirname(target)) syncDirectory(path.dirname(target));
}

function atomicWrite(filePath, body) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  durableRename(temp, filePath);
}

function writeBodyDurably(filePath, body) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  durableRename(temp, filePath);
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function appendDurably(filePath, line) {
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(fd, line, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

class DurableObservationQueue {
  constructor(rootDirectory) {
    this.root = path.resolve(rootDirectory);
    this.pending = path.join(this.root, 'pending');
    this.processed = path.join(this.root, 'processed');
    this.failed = path.join(this.root, 'failed');
    this.logPath = path.join(this.root, 'queue.jsonl');
    ensure(this.pending);
    ensure(this.processed);
    ensure(this.failed);
  }

  enqueue(metadata, body) {
    const observationId = metadata.observationId || metadata.observation_id || `obs-${crypto.randomUUID()}`;
    const safeId = observationId.replace(/[^A-Za-z0-9_.-]/g, '_');
    const bodyPath = path.join(this.pending, `${safeId}.body`);
    const metadataPath = path.join(this.pending, `${safeId}.json`);
    const item = {
      ...metadata,
      observationId,
      queuedAt: new Date().toISOString(),
      attempts: Number(metadata.attempts || 0),
      availableAt: new Date().toISOString(),
      bodyPath: bodyPath
    };
    writeBodyDurably(bodyPath, body);
    atomicWrite(metadataPath, Buffer.from(`${JSON.stringify(item)}\n`));
    appendDurably(this.logPath, `${JSON.stringify({ observationId, status: 'pending', at: item.queuedAt })}\n`);
    return item;
  }

  recoverPartialMoves() {
    const directories = [this.pending, this.processed, this.failed];
    const metadataByName = new Map();
    const bodyByName = new Map();
    for (const directory of directories) {
      for (const file of fs.readdirSync(directory)) {
        if (file.endsWith('.json')) {
          const metadataPath = path.join(directory, file);
          if (readJson(metadataPath)) metadataByName.set(file, [...(metadataByName.get(file) || []), metadataPath]);
        } else if (file.endsWith('.body')) {
          const bodyPath = path.join(directory, file);
          bodyByName.set(file, [...(bodyByName.get(file) || []), bodyPath]);
        }
      }
    }
    for (const [metadataName, metadataPaths] of metadataByName) {
      if (metadataPaths.length !== 1) continue;
      const metadataPath = metadataPaths[0];
      const bodyName = metadataName.replace(/\.json$/, '.body');
      const bodyPaths = bodyByName.get(bodyName) || [];
      if (bodyPaths.length !== 1) continue;
      const bodyPath = bodyPaths[0];
      const metadataDirectory = path.dirname(metadataPath);
      const bodyDirectory = path.dirname(bodyPath);
      // The body is renamed first during processing. If it already reached a
      // terminal directory, follow it and complete the metadata move. The
      // inverse handles a crash after the metadata move. Pending/pending is a
      // complete pair and needs no action.
      const targetDirectory = bodyDirectory !== this.pending ? bodyDirectory
        : metadataDirectory !== this.pending ? this.pending
          : null;
      if (!targetDirectory) continue;
      if (bodyDirectory !== targetDirectory) durableRename(bodyPath, path.join(targetDirectory, bodyName));
      if (metadataDirectory !== targetDirectory) durableRename(metadataPath, path.join(targetDirectory, metadataName));
    }
  }

  recoverRawDirectory(rawDirectory) {
    this.recoverPartialMoves();
    const manifestPath = path.join(path.resolve(rawDirectory), 'manifest.jsonl');
    if (!fs.existsSync(manifestPath)) return 0;
    const known = new Set();
    for (const directory of [this.pending, this.processed, this.failed]) {
      for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
        const item = readJson(path.join(directory, file));
        if (item?.observationId) known.add(item.observationId);
      }
    }
    let recovered = 0;
    for (const line of fs.readFileSync(manifestPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let item;
      try { item = JSON.parse(line); } catch (_) { continue; }
      if (!item.observationId || item.parseStatus !== 'pending' || !item.rawPath || known.has(item.observationId)) continue;
      if (!fs.existsSync(item.rawPath)) continue;
      this.enqueue(item, fs.readFileSync(item.rawPath));
      known.add(item.observationId);
      recovered += 1;
    }
    return recovered;
  }

  pendingItems(now = Date.now()) {
    const files = fs.readdirSync(this.pending).filter(file => file.endsWith('.json')).sort();
    const items = [];
    for (const file of files) {
      const metadataPath = path.join(this.pending, file);
      const item = readJson(metadataPath);
      if (!item) continue;
      const availableAt = Date.parse(item.availableAt || 0);
      if (Number.isFinite(availableAt) && availableAt > now) continue;
      const bodyPath = path.join(this.pending, file.replace(/\.json$/, '.body'));
      if (!fs.existsSync(bodyPath)) continue;
      item.metadataPath = metadataPath;
      item.bodyPath = bodyPath;
      items.push(item);
    }
    return items;
  }

  recoverFailed(now = Date.now()) {
    const files = fs.readdirSync(this.failed).filter(file => file.endsWith('.json')).sort();
    let recovered = 0;
    for (const file of files) {
      const metadataPath = path.join(this.failed, file);
      const item = readJson(metadataPath);
      if (!item) continue;
      const availableAt = Date.parse(item.availableAt || 0);
      if (Number.isFinite(availableAt) && availableAt > now) continue;
      const bodyPath = path.join(this.failed, file.replace(/\.json$/, '.body'));
      if (!fs.existsSync(bodyPath)) continue;
      durableRename(bodyPath, path.join(this.pending, path.basename(bodyPath)));
      durableRename(metadataPath, path.join(this.pending, path.basename(metadataPath)));
      recovered += 1;
    }
    return recovered;
  }

  async process(handler, options = {}) {
    const now = options.now || Date.now();
    const maxItems = Number(options.maxItems || Infinity);
    const retryBaseMs = Number(options.retryBaseMs || 30_000);
    const maxAttempts = Number(options.maxAttempts || 5);
    this.recoverPartialMoves();
    this.recoverFailed(now);
    const processed = [];
    for (const item of this.pendingItems(now).slice(0, maxItems)) {
      try {
        const body = fs.readFileSync(item.bodyPath);
        const outcome = await handler(body, item);
        if (outcome && typeof outcome === 'object') {
          if (outcome.status) item.parseStatus = outcome.status;
          if (outcome.parsed?.completeness) item.completeness = outcome.parsed.completeness;
        }
        atomicWrite(item.metadataPath, Buffer.from(`${JSON.stringify(item)}\n`));
        const destinationBody = path.join(this.processed, path.basename(item.bodyPath));
        const destinationMetadata = path.join(this.processed, path.basename(item.metadataPath));
        durableRename(item.bodyPath, destinationBody);
        durableRename(item.metadataPath, destinationMetadata);
        appendDurably(this.logPath, `${JSON.stringify({ observationId: item.observationId, status: 'processed', at: new Date().toISOString() })}\n`);
        processed.push({ item, status: 'processed' });
      } catch (error) {
        item.attempts = Number(item.attempts || 0) + 1;
        item.lastError = error?.message || String(error);
        item.availableAt = new Date(Date.now() + Math.min(60 * 60_000, retryBaseMs * (2 ** Math.min(item.attempts, 8)))).toISOString();
        if (item.attempts >= maxAttempts) {
          const destinationBody = path.join(this.failed, path.basename(item.bodyPath));
          const destinationMetadata = path.join(this.failed, path.basename(item.metadataPath));
          atomicWrite(item.metadataPath, Buffer.from(`${JSON.stringify(item)}\n`));
          durableRename(item.bodyPath, destinationBody);
          durableRename(item.metadataPath, destinationMetadata);
          item.bodyPath = destinationBody;
          item.metadataPath = destinationMetadata;
          appendDurably(this.logPath, `${JSON.stringify({ observationId: item.observationId, status: 'failed', attempts: item.attempts, at: new Date().toISOString() })}\n`);
          processed.push({ item, status: 'failed', error });
        } else {
          atomicWrite(item.metadataPath, Buffer.from(`${JSON.stringify(item)}\n`));
          appendDurably(this.logPath, `${JSON.stringify({ observationId: item.observationId, status: 'retry', attempts: item.attempts, at: new Date().toISOString() })}\n`);
          processed.push({ item, status: 'retry', error });
        }
      }
    }
    return processed;
  }

  depth() {
    return this.pendingItems(Date.now()).length;
  }

  status() {
    const count = directory => fs.readdirSync(directory).filter(file => file.endsWith('.body')).length;
    return { pending: count(this.pending), processed: count(this.processed), failed: count(this.failed) };
  }
}

module.exports = { DurableObservationQueue, writeBodyDurably, atomicWrite };
