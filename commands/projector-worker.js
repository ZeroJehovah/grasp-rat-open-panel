#!/usr/bin/env node
'use strict';

const path = require('path');
const { DurableObservationQueue } = require('../collector/queue');
const { PostgresPanelStore } = require('../storage/postgres-store');

const queue = new DurableObservationQueue(process.env.GRASP_RAT_PANEL_QUEUE_DIR || path.resolve(__dirname, '../../data/spool'));
const store = new PostgresPanelStore({ connectionString: process.env.DATABASE_URL });
let stopping = false;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for projector-worker');
  await store.hydrate();
  while (!stopping) {
    const items = await queue.process(async (body, item) => store.applyObservation(body, {
      observationId: item.observationId,
      observedAt: item.observedAt,
      receivedAt: item.receivedAt,
      rawPath: item.rawPath,
      payloadHash: item.payloadHash,
      bytes: item.bytes,
      statusCode: item.statusCode,
      durationMs: item.durationMs,
      egressId: item.egressId,
      egressGroup: item.egressGroup,
      retryNo: item.retryNo
    }), { maxItems: 20 });
    if (items.length === 0) await sleep(1000);
  }
}

const stop = async () => {
  stopping = true;
  await store.close();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
run().catch(async error => { console.error(error?.stack || error); await stop(); process.exitCode = 1; });
