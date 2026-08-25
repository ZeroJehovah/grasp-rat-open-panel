#!/usr/bin/env node
'use strict';

// Rebuilds player_daily_quota (and the current-day player_quota_current
// baseline) for whole business days from the retained raw snapshots.
//
// It exists because the game flips daily_budget_day_key_utc8 one snapshot
// before it refills the per-day entity fields: the first frame of a new day can
// report external_balance_snapshot = 0 for players who still hold a balance.
// Rows projected from such a frame carry initial_quota = 0, which turns the next
// frame's restored balance into a full day of phantom income. The same guard the
// projector now applies is replayed here so already stored days can be repaired.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { parseSnapshot } = require('../domain/snapshot');

const EXTERNAL_BALANCE_PER_QUOTA = 500_000;
const ROLLOVER_ZERO_GUARD_MS = 30 * 60 * 1000;
const FILE_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-/;

function parseArgs(argv) {
  const options = {
    days: [],
    rawDir: process.env.GRASP_RAT_PANEL_SNAPSHOT_DIR || path.resolve(__dirname, '../../data/raw-snapshots'),
    minSteadyEntities: null,
    dryRun: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--raw-dir') options.rawDir = path.resolve(value());
    else if (arg === '--min-steady') options.minSteadyEntities = Number(value());
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) options.days.push(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
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

// Mirrors ProjectionEngine.isRolloverZeroBalance: a zero reading that would open
// a new day for a player who still holds a balance is held back until a
// trustworthy reading arrives, and the hold expires so a player who really
// starts a day at zero is still recorded.
function isRolloverZeroBalance(entry, externalBalance, serverDay, observedAt) {
  const suspect = externalBalance === 0 && entry.day !== null && entry.day !== serverDay && entry.lastValue !== null && entry.lastValue > 0;
  if (!suspect) {
    entry.guard = null;
    return false;
  }
  if (!entry.guard || entry.guard.day !== serverDay) {
    entry.guard = { day: serverDay, since: observedAt };
    return true;
  }
  if (Date.parse(observedAt) - Date.parse(entry.guard.since) > ROLLOVER_ZERO_GUARD_MS) {
    entry.guard = null;
    return false;
  }
  return true;
}

function replay(options) {
  const files = fs.readdirSync(options.rawDir).filter(name => FILE_PATTERN.test(name)).sort();
  const wanted = new Set(options.days);
  const state = new Map();
  const rebuilt = new Map();
  // Players whose only readings for a wanted day were held back have no
  // trustworthy balance for that day at all, so their stored row has to be
  // cleared rather than repaired.
  const heldBack = new Set();
  const summary = { files: files.length, parsed: 0, warming: 0, skipped: 0, zeroReadingsIgnored: 0, firstObservedAt: null, lastObservedAt: null };
  for (const name of files) {
    const observedAt = observedAtFromName(name);
    if (!observedAt) continue;
    const parsed = parseSnapshot(fs.readFileSync(path.join(options.rawDir, name)), {
      observedAt,
      minSteadyEntities: options.minSteadyEntities === null ? undefined : options.minSteadyEntities
    });
    // Only `invalid` is skipped. A warming-up response carries fewer entities,
    // but each entity's own `external_balance_snapshot` is as trustworthy as it
    // is in a full one — and refusing those frames is exactly how the projector
    // lost the start-of-day baseline this command exists to repair.
    if (parsed.completeness === 'invalid') { summary.skipped += 1; continue; }
    if (parsed.completeness !== 'steady') summary.warming += 1;
    summary.parsed += 1;
    for (const entity of parsed.entities) {
      const uid = entity.user_id === null || entity.user_id === undefined ? null : String(entity.user_id);
      if (!uid) continue;
      const externalBalance = typeof entity.external_balance_snapshot === 'number' && Number.isFinite(entity.external_balance_snapshot)
        ? entity.external_balance_snapshot
        : null;
      let entry = state.get(uid);
      if (!entry) {
        entry = { userId: entity.user_id, day: null, lastValue: null, guard: null };
        state.set(uid, entry);
      }
      if (isRolloverZeroBalance(entry, externalBalance, parsed.serverDay, observedAt)) {
        summary.zeroReadingsIgnored += 1;
        if (wanted.has(parsed.serverDay)) heldBack.add(`${parsed.serverDay}:${uid}`);
        continue;
      }
      const quotaValue = externalBalance === null ? null : externalBalance / EXTERNAL_BALANCE_PER_QUOTA;
      entry.lastValue = quotaValue;
      entry.day = parsed.serverDay;
      if (!wanted.has(parsed.serverDay)) continue;
      const dayKey = `${parsed.serverDay}:${uid}`;
      const daily = rebuilt.get(dayKey);
      if (!daily) rebuilt.set(dayKey, { localDate: parsed.serverDay, userId: entity.user_id, initial: quotaValue, closing: quotaValue });
      else {
        if (daily.initial === null) daily.initial = quotaValue;
        daily.closing = quotaValue;
      }
    }
    if (!summary.firstObservedAt) summary.firstObservedAt = observedAt;
    summary.lastObservedAt = observedAt;
  }
  for (const key of rebuilt.keys()) heldBack.delete(key);
  return { rebuilt, heldBack, summary };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: rebuild-quota-from-snapshots.js <YYYY-MM-DD...> [--raw-dir DIR] [--min-steady N] [--dry-run]');
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { rebuilt, heldBack, summary } = replay(options);
  const latestDay = options.days.slice().sort().pop();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const changes = { updated: 0, unchanged: 0, missingRow: 0, cleared: 0, quotaCurrent: 0 };
    const samples = [];
    await client.query('BEGIN');
    for (const daily of rebuilt.values()) {
      const income = daily.initial === null || daily.closing === null ? null : daily.closing - daily.initial;
      const existing = await client.query('SELECT initial_quota, closing_quota, income FROM player_daily_quota WHERE local_date = $1::date AND user_id = $2', [daily.localDate, daily.userId]);
      if (existing.rowCount === 0) { changes.missingRow += 1; continue; }
      const before = existing.rows[0];
      const same = Number(before.initial_quota) === daily.initial && Number(before.closing_quota) === daily.closing && Number(before.income) === income;
      if (same) { changes.unchanged += 1; continue; }
      changes.updated += 1;
      if (samples.length < 5) samples.push({ localDate: daily.localDate, userId: daily.userId, incomeBefore: before.income === null ? null : Number(before.income), incomeAfter: income });
      if (options.dryRun) continue;
      await client.query('UPDATE player_daily_quota SET initial_quota = $3, closing_quota = $4, income = $5 WHERE local_date = $1::date AND user_id = $2', [daily.localDate, daily.userId, daily.initial, daily.closing, income]);
    }
    for (const key of heldBack) {
      const [localDate, userId] = key.split(':');
      changes.cleared += 1;
      if (options.dryRun) continue;
      await client.query('UPDATE player_daily_quota SET initial_quota = NULL, closing_quota = NULL, income = NULL WHERE local_date = $1::date AND user_id = $2', [localDate, Number(userId)]);
    }
    // The projector rebuilds a player's baseline whenever quota_source is not
    // external_balance_snapshot, so the repaired current-day baseline has to be
    // published together with its source or the next snapshot would discard it.
    // Rows left untouched keep their stale source on purpose: the projector then
    // rebuilds their baseline from the first trustworthy reading it sees.
    if (!options.dryRun) {
      for (const daily of rebuilt.values()) {
        if (daily.localDate !== latestDay) continue;
        const result = await client.query(`UPDATE player_quota_current
          SET quota_day = $2::date, initial_quota = $3, quota_value = $4, quota_source = 'external_balance_snapshot'
          WHERE user_id = $1`, [daily.userId, latestDay, daily.initial, daily.closing]);
        changes.quotaCurrent += result.rowCount;
      }
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    const perDay = {};
    for (const daily of rebuilt.values()) perDay[daily.localDate] = (perDay[daily.localDate] || 0) + 1;
    console.log(JSON.stringify({ type: 'quota-rebuilt', days: options.days, dryRun: options.dryRun, rows: rebuilt.size, perDay, ...summary, ...changes, samples }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
