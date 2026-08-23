#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

function getJson(url, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { accept: 'application/json', 'user-agent': 'grasp-rat-open-panel-map-metadata/1.0' }, timeout: timeoutMs }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`map metadata HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`map metadata timeout after ${timeoutMs}ms`)));
    request.on('error', reject);
  });
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

async function refresh(options = {}) {
  const endpoint = options.endpoint || process.env.GRASP_RAT_PANEL_MINIMAP_URL || 'https://grasp-rat-game.h-e.top/minimap';
  const output = path.resolve(options.output || process.env.GRASP_RAT_PANEL_MAP_METADATA_FILE || path.resolve(__dirname, '../../data/map-metadata.json'));
  const payload = await getJson(endpoint, options.timeoutMs);
  const radius = Number(payload.world_radius_cm);
  if (!payload.ok || !Number.isFinite(radius) || radius <= 0) throw new Error('minimap did not return a positive world_radius_cm');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(output, 'utf8')); } catch (_) { /* first refresh */ }
  const version = previous && Number(previous.worldRadius) === radius ? Number(previous.version) || 1 : (Number(previous?.version) || 0) + 1;
  const metadata = {
    id: 'grasp-rat-world',
    version,
    source: '/minimap',
    coordinateUnit: 'centimetre',
    worldRadius: radius,
    bounds: { minX: -radius, maxX: radius, minY: -radius, maxY: radius },
    center: { x: 0, y: 0 },
    shape: 'circle',
    directions: ['上', '右上', '右', '右下', '下', '左下', '左', '左上'],
    distanceUnit: 'm',
    metersPerGameUnit: 0.01,
    refreshedAt: new Date().toISOString()
  };
  atomicWrite(output, metadata);
  return { output, metadata };
}

if (require.main === module) refresh().then(result => console.log(JSON.stringify({ type: 'map-metadata-refreshed', ...result }, null, 2))).catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

module.exports = { getJson, refresh };
