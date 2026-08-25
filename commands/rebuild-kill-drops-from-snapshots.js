#!/usr/bin/env node
'use strict';

// Repairs the death evidence stored on kill_events (and the coin drop each kill
// is linked to) for whole business days, by replaying the retained raw
// snapshots through the projector.
//
// It exists because two evidence rules were wrong for as long as kill_events
// has existed. A victim's `death_drop_coins` is a point-in-time reading, but
// stale state left over from the previous world was accepted as evidence, so a
// kill could be stored with the coins its victim had been carrying the night
// before. And the coin drop lying on the ground carries the *victim's* user id,
// not the killer's, so matching on the killer linked no drop to any kill at all
// and threw away the only evidence that survives when the victim is missing from
// the frames around their own death.
//
// The projector now applies both rules; this command replays them over days that
// were already stored. It only ever replaces a stored value with a value the
// replay could actually derive — a row the raw snapshots cannot speak to is
// left exactly as it is rather than blanked.
//
// `backfill-postgres.js` deliberately refuses a non-empty target, so it cannot
// be used for this: it reimports history into an empty database instead of
// repairing rows that live alongside the running pipeline.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { ProjectionEngine } = require('../domain/projector');
const { localDateFromTimestamp } = require('../domain/snapshot');

const FILE_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-/;
// The evidence for a kill in the first minutes of a day sits in the frames
// before midnight, so the replay has to start earlier than the day it repairs.
const DEFAULT_LEAD_IN_FRAMES = 120;

function parseArgs(argv) {
  const options = {
    days: [],
    rawDir: process.env.GRASP_RAT_PANEL_SNAPSHOT_DIR || path.resolve(__dirname, '../../data/raw-snapshots'),
    leadInFrames: DEFAULT_LEAD_IN_FRAMES,
    minSteadyEntities: null,
    dryRun: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--raw-dir') options.rawDir = path.resolve(value());
    else if (arg === '--lead-in-frames') options.leadInFrames = Number(value());
    else if (arg === '--min-steady') options.minSteadyEntities = Number(value());
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) options.days.push(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.leadInFrames) || options.leadInFrames < 0) throw new Error('--lead-in-frames must be a non-negative integer');
  if (options.minSteadyEntities !== null && !Number.isFinite(options.minSteadyEntities)) throw new Error('--min-steady must be a number');
  if (!options.help && options.days.length === 0) throw new Error('at least one YYYY-MM-DD day is required');
  return options;
}

function observedAtFromName(name) {
  const match = FILE_PATTERN.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, milli] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${milli}Z`;
}

function replay(options) {
  const wanted = new Set(options.days);
  const files = fs.readdirSync(options.rawDir)
    .filter(name => FILE_PATTERN.test(name))
    .sort()
    .map(name => ({ name, observedAt: observedAtFromName(name) }))
    .filter(item => item.observedAt);
  const firstWanted = files.findIndex(item => wanted.has(localDateFromTimestamp(item.observedAt)));
  const lastWanted = files.reduce((last, item, index) => (wanted.has(localDateFromTimestamp(item.observedAt)) ? index : last), -1);
  if (firstWanted === -1) throw new Error('no retained raw snapshot falls on the requested days');
  const window = files.slice(Math.max(0, firstWanted - options.leadInFrames), lastWanted + 1);
  const engine = new ProjectionEngine(options.minSteadyEntities === null ? {} : { minSteadyEntities: options.minSteadyEntities });
  for (const item of window) {
    engine.applyObservation(fs.readFileSync(path.join(options.rawDir, item.name)), {
      observationId: `kill-drop-rebuild-${item.name}`,
      observedAt: item.observedAt,
      statusCode: 200
    });
  }
  const kills = Array.from(engine.kills.values()).filter(kill => wanted.has(kill.local_date));
  const drops = Array.from(engine.drops.values()).filter(drop => wanted.has(drop.server_day) && drop.kill_event_id);
  return { kills, drops, summary: { files: window.length, leadInFrames: Math.min(options.leadInFrames, firstWanted), firstObservedAt: window[0]?.observedAt || null, lastObservedAt: window.at(-1)?.observedAt || null } };
}

function sameJson(before, after) {
  if (after === null || after === undefined) return true;
  return JSON.stringify(before === null || before === undefined ? null : before) === JSON.stringify(after);
}

function sameNumber(before, after) {
  if (after === null || after === undefined) return true;
  return before !== null && before !== undefined && Number(before) === Number(after);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: rebuild-kill-drops-from-snapshots.js <YYYY-MM-DD...> [--raw-dir DIR] [--lead-in-frames N] [--min-steady N] [--dry-run]');
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { kills, drops, summary } = replay(options);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const changes = { kills: kills.length, killsUpdated: 0, killsUnchanged: 0, killsMissingRow: 0, killsWithoutEvidence: 0, dropsLinked: 0, dropsAlreadyLinked: 0 };
    const samples = [];
    await client.query('BEGIN');
    for (const kill of kills) {
      if (kill.drop === null || kill.drop.amount === null || kill.drop.amount === undefined) changes.killsWithoutEvidence += 1;
      const existing = await client.query('SELECT drop, evidence_snapshot_id, victim_position, killer_position, victim_stamina_5s, victim_stamina_5s_limit FROM kill_events WHERE local_date = $1::date AND kill_id = $2', [kill.local_date, kill.kill_id]);
      if (existing.rowCount === 0) { changes.killsMissingRow += 1; continue; }
      const before = existing.rows[0];
      const sameDrop = sameJson(before.drop === null ? null : { amount: before.drop.amount === null || before.drop.amount === undefined ? null : Number(before.drop.amount), confidence: before.drop.confidence || null }, kill.drop === null ? null : { amount: kill.drop.amount === null ? null : Number(kill.drop.amount), confidence: kill.drop.confidence || null });
      const same = sameDrop
        && sameJson(before.victim_position, kill.victim_position)
        && sameJson(before.killer_position, kill.killer_position)
        && sameNumber(before.victim_stamina_5s, kill.victim_stamina_5s)
        && sameNumber(before.victim_stamina_5s_limit, kill.victim_stamina_5s_limit);
      if (same) { changes.killsUnchanged += 1; continue; }
      changes.killsUpdated += 1;
      if (samples.length < 8) samples.push({ killId: kill.kill_id, tick: kill.tick, dropBefore: before.drop === null ? null : before.drop.amount, dropAfter: kill.drop === null ? null : kill.drop.amount });
      if (options.dryRun) continue;
      // COALESCE keeps a stored value the replay could not derive. This command
      // repairs wrong evidence; it never erases evidence.
      await client.query(`UPDATE kill_events SET
          drop = COALESCE($3::jsonb, drop),
          evidence_snapshot_id = COALESCE($4, evidence_snapshot_id),
          victim_position = COALESCE($5::jsonb, victim_position),
          killer_position = COALESCE($6::jsonb, killer_position),
          victim_stamina_5s = COALESCE($7, victim_stamina_5s),
          victim_stamina_5s_limit = COALESCE($8, victim_stamina_5s_limit)
        WHERE local_date = $1::date AND kill_id = $2`, [
        kill.local_date,
        kill.kill_id,
        kill.drop === null ? null : JSON.stringify(kill.drop),
        kill.evidence_snapshot_id,
        kill.victim_position === null ? null : JSON.stringify(kill.victim_position),
        kill.killer_position === null ? null : JSON.stringify(kill.killer_position),
        kill.victim_stamina_5s,
        kill.victim_stamina_5s_limit
      ]);
    }
    for (const drop of drops) {
      const existing = await client.query('SELECT kill_event_id, confidence FROM coin_drop_lifecycles WHERE server_day = $1::date AND drop_id = $2', [drop.server_day, drop.drop_id]);
      if (existing.rowCount === 0) continue;
      if (existing.rows[0].kill_event_id === drop.kill_event_id && existing.rows[0].confidence === drop.confidence) { changes.dropsAlreadyLinked += 1; continue; }
      changes.dropsLinked += 1;
      if (options.dryRun) continue;
      await client.query('UPDATE coin_drop_lifecycles SET kill_event_id = $3, confidence = $4 WHERE server_day = $1::date AND drop_id = $2', [drop.server_day, drop.drop_id, drop.kill_event_id, drop.confidence]);
    }
    if (options.dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');
    console.log(JSON.stringify({ type: 'kill-drops-rebuilt', days: options.days, dryRun: options.dryRun, ...summary, ...changes, samples }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

module.exports = { parseArgs, replay };
