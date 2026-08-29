'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const {
  BUSINESS_TIMEZONE,
  SCHEMA_VERSION,
  parseSnapshot,
  diffState,
  tickToIso,
  localDateFromTimestamp,
  presetRangesForDates,
  cloneJson
} = require('./snapshot');

const DEFAULT_MAP_METADATA = Object.freeze({
  id: 'grasp-rat-world',
  version: 1,
  source: '/minimap',
  coordinateUnit: 'centimetre',
  worldRadius: 1000000,
  bounds: { minX: -1000000, maxX: 1000000, minY: -1000000, maxY: 1000000 },
  center: { x: 0, y: 0 },
  shape: 'circle',
  directions: ['上', '右上', '右', '右下', '下', '左下', '左', '左上'],
  distanceUnit: 'm',
  metersPerGameUnit: 0.01
});

const EXTERNAL_BALANCE_PER_QUOTA = 500_000;
const ROLLOVER_ZERO_GUARD_MS = 30 * 60 * 1000;

function loadMapMetadata(options = {}) {
  const filePath = options.mapMetadataFile || process.env.PANEL_MAP_METADATA_FILE || path.resolve(__dirname, '../../data/map-metadata.json');
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (value && Number.isFinite(Number(value.version)) && value.bounds && value.center) return value;
  } catch (_) { /* the versioned built-in metadata remains available during bootstrap */ }
  return null;
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function userKey(value) {
  return value === null || value === undefined ? null : String(value);
}

function mapKey(...parts) {
  return parts.map(part => String(part ?? '')).join(':');
}

function sortByNumberDesc(values, value) {
  return values.sort((a, b) => {
    const av = numeric(value(a));
    const bv = numeric(value(b));
    if (av === null && bv === null) return String(a.user_id).localeCompare(String(b.user_id));
    if (av === null) return 1;
    if (bv === null) return -1;
    if (bv !== av) return bv - av;
    return String(a.user_id).localeCompare(String(b.user_id));
  });
}

function sortNames(values) {
  return values.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-u-co-pinyin') || Number(a.userId ?? a.user_id) - Number(b.userId ?? b.user_id));
}

function mapPlayerView(player) {
  return {
    userId: player.userId,
    name: player.name,
    online: player.online,
    drop: player.drop,
    state: player.state ? {
      hp: player.state.hp,
      maxHp: player.state.maxHp,
      x: player.state.x,
      y: player.state.y,
      invulnerableRemainingSecs: player.state.invulnerableRemainingSecs,
      loss: player.state.loss,
      stamina5s: player.state.stamina5s,
      stamina1h: player.state.stamina1h,
      stamina1d: player.state.stamina1d,
      stamina5sLimit: player.state.stamina5sLimit,
      stamina1hLimit: player.state.stamina1hLimit,
      stamina1dLimit: player.state.stamina1dLimit
    } : null
  };
}

function historyQuotaView(row) {
  return {
    local_date: String(row.local_date).slice(0, 10),
    user_id: Number(row.user_id),
    initial_quota: numeric(row.initial_quota),
    closing_quota: numeric(row.closing_quota),
    income: numeric(row.income),
    finalized_at: row.finalized_at || null
  };
}

function historyStatView(row) {
  return {
    local_date: String(row.local_date).slice(0, 10),
    user_id: Number(row.user_id),
    kills: Number(row.kills || 0),
    deaths: Number(row.deaths || 0)
  };
}

function parseKillNames(text) {
  const match = /^(.*?)\s+killed\s+(.*)$/i.exec(String(text || ''));
  return match ? { killer: match[1].trim(), victim: match[2].trim() } : { killer: null, victim: null };
}

function safeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function defaultObservationId(metadata, body) {
  const hash = metadata.payloadHash || require('crypto').createHash('sha256').update(body).digest('hex');
  return `obs-${hash.slice(0, 24)}-${Date.now().toString(36)}`;
}

class ProjectionEngine {
  constructor(options = {}) {
    this.options = options;
    this.mapMetadata = cloneJson(options.mapMetadata || loadMapMetadata(options) || DEFAULT_MAP_METADATA);
    this.reset();
  }

  reset() {
    this.observations = [];
    this.observationById = new Map();
    this.versions = [];
    this.versionByKey = new Map();
    this.players = new Map();
    this.nameHistory = new Map();
    this.entityHistory = new Map();
    this.stateBases = [];
    this.stateDeltas = [];
    this.currentStates = new Map();
    this.onlineIntervals = [];
    this.openIntervals = new Map();
    this.messages = new Map();
    this.kills = new Map();
    this.drops = new Map();
    this.lastTouchedDrops = [];
    this.lastTouchedKills = [];
    this.dailyStats = new Map();
    this.quotaCurrent = new Map();
    this.dailyQuota = new Map();
    this.zeroBalanceGuards = new Map();
    this.lastStableUsers = new Set();
    this.lastClosedUsers = [];
    this.lastTouchedIntervals = [];
    this.lastStableVersion = null;
    // `lastStableVersion` anchors interval accounting and must only ever move on
    // a steady projection. `lastVersion` is the newest accepted version of any
    // completeness and is what realtime reads resolve against, so a repopulating
    // world after a reset is never answered with the previous day's snapshot.
    this.lastVersion = null;
    this.lastWarmingUsers = [];
    this.lastParserCursor = null;
    this.sequence = 0;
  }

  recordObservation(metadata, parseResult) {
    const observation = {
      observation_id: metadata.observationId || metadata.observation_id || defaultObservationId(metadata, metadata.body || Buffer.alloc(0)),
      observed_at: safeDate(metadata.observedAt || metadata.observed_at || new Date()),
      received_at: safeDate(metadata.receivedAt || metadata.received_at || metadata.observedAt || new Date()),
      status_code: metadata.statusCode ?? metadata.status_code ?? null,
      duration_ms: metadata.durationMs ?? metadata.duration_ms ?? null,
      body_bytes: metadata.bytes ?? metadata.body_bytes ?? metadata.body?.length ?? null,
      payload_hash: metadata.payloadHash || parseResult?.payloadHash || null,
      raw_path: metadata.rawPath || metadata.raw_path || null,
      egress_id: metadata.egressId || metadata.egress_id || null,
      egress_group: metadata.egressGroup || metadata.egress_group || null,
      retry_no: metadata.retryNo ?? metadata.retry_no ?? 0,
      error: metadata.error || (parseResult?.errors?.length ? parseResult.errors.join('; ') : null),
      schema_version: parseResult?.schemaVersion || metadata.schemaVersion || null,
      parse_status: parseResult?.parseStatus || metadata.parseStatus || 'pending',
      sequence: this.sequence += 1
    };
    this.observations.push(observation);
    this.observationById.set(observation.observation_id, observation);
    return observation;
  }

  applyObservation(body, metadata = {}) {
    const observedAt = metadata.observedAt || metadata.observed_at || new Date().toISOString();
    const parseResult = parseSnapshot(body, {
      observedAt,
      previous: this.lastParserCursor,
      minSteadyEntities: this.options.minSteadyEntities
    });
    const observation = this.recordObservation({ ...metadata, observedAt, body, payloadHash: metadata.payloadHash }, parseResult);
    observation.parse_status = parseResult.parseStatus;
    observation.schema_version = parseResult.schemaVersion;
    observation.payload_hash = parseResult.payloadHash;
    if (parseResult.serverDay && Number.isFinite(parseResult.serverTick)) {
      this.lastParserCursor = {
        serverDay: parseResult.serverDay,
        serverTick: parseResult.serverTick,
        resetGeneration: parseResult.resetGeneration
      };
    }
    if (parseResult.completeness === 'invalid') {
      observation.parse_status = 'invalid';
      return { observation, parsed: parseResult, status: 'invalid' };
    }
    const existing = this.versionByKey.get(parseResult.snapshotKey);
    if (existing) {
      existing.duplicate_poll_count += 1;
      existing.last_observed_at = observation.observed_at;
      existing.observation_ids.push(observation.observation_id);
      observation.parse_status = 'duplicate';
      return { observation, parsed: parseResult, version: existing, status: 'duplicate' };
    }
    const version = {
      snapshot_id: parseResult.snapshotId,
      version_token: parseResult.snapshotId,
      server_day: parseResult.serverDay,
      reset_generation: parseResult.resetGeneration,
      server_tick: parseResult.serverTick,
      observed_at: observation.observed_at,
      received_at: observation.received_at,
      entity_count: parseResult.entityCount,
      total_entities: parseResult.totalEntities,
      bullet_count: parseResult.bulletCount,
      coin_drop_count: parseResult.coinDropCount,
      message_count: parseResult.messageCount,
      payload_hash: parseResult.payloadHash,
      completeness: parseResult.completeness,
      schema_version: parseResult.schemaVersion,
      duplicate_poll_count: 0,
      observation_ids: [observation.observation_id],
      errors: parseResult.errors
    };
    this.versionByKey.set(parseResult.snapshotKey, version);
    this.versions.push(version);
    this.lastVersion = version;
    observation.parse_status = parseResult.completeness === 'steady' ? 'projected' : 'warming_up';
    if (parseResult.completeness !== 'steady') {
      // A warming-up response may still contain trustworthy rolling message and
      // drop buffers. Keep those object IDs idempotent, and let the entity set
      // advance the displayed current state so realtime reads follow the live
      // world while it repopulates.
      //
      // Quota accounting runs here as well. `external_balance_snapshot` is a
      // fact about the player carrying it, and an incomplete entity set says
      // nothing about the players it does contain. Holding these frames back
      // anchored the daily baseline on the first steady snapshot instead of the
      // first reading of the day, so everything earned in between vanished:
      // on 2026-08-26 that was 662 of one player's 1,169.
      //
      // Still steady-only: online intervals and the base/delta chain. Those are
      // the two things that read meaning into a player's absence, so an
      // incomplete set must never drive them.
      const entitiesByUser = new Map(parseResult.entities.map(entity => [userKey(entity.user_id), entity]));
      const previousStates = this.projectWarmingState(parseResult, version);
      this.projectMessages(parseResult, version, entitiesByUser, previousStates);
      this.projectDrops(parseResult, version, false);
      this.projectQuota(parseResult, version);
      return { observation, parsed: parseResult, version, status: 'warming_up' };
    }
    this.projectStableVersion(parseResult, version);
    return { observation, parsed: parseResult, version, status: 'projected' };
  }

  // Display-only projection for an incomplete entity set. `players` and
  // `player_state_current` are what the realtime views render, so they follow
  // the newest snapshot even while the world is still filling up after a reset.
  // What depends on the set being complete is deliberately left alone: no
  // interval is opened or closed, no daily kill/death stat moves, and no
  // base/delta row is written. Returns the pre-update states so kill evidence is
  // still resolved against the state that preceded this snapshot.
  projectWarmingState(parsed, version) {
    const previousStates = new Map(this.currentStates);
    this.lastWarmingUsers = [];
    for (const entity of parsed.entities) {
      const uid = userKey(entity.user_id);
      if (!uid) continue;
      const previousState = previousStates.get(uid);
      const segmentId = previousState?.segment_id || `segment-${parsed.snapshotId}-${uid}`;
      const player = this.players.get(uid) || {
        user_id: entity.user_id,
        first_seen_at: version.observed_at,
        current_name: entity.name || '',
        current_entity_id: entity.entity_id,
        online: true
      };
      player.last_seen_at = version.observed_at;
      player.current_name = entity.name || player.current_name || '';
      player.current_entity_id = entity.entity_id;
      player.online = true;
      player.last_snapshot_id = parsed.snapshotId;
      player.segment_id = segmentId;
      this.players.set(uid, player);
      // `from_warming` makes the next steady projection open a fresh segment and
      // write a full base row, so the delta chain is never diffed against a
      // state that was never persisted as a base or a delta.
      this.currentStates.set(uid, {
        ...entity,
        snapshot_id: parsed.snapshotId,
        observed_at: version.observed_at,
        server_day: parsed.serverDay,
        reset_generation: parsed.resetGeneration,
        entity_id: entity.entity_id,
        segment_id: segmentId,
        online: true,
        from_warming: true
      });
      this.lastWarmingUsers.push(entity.user_id);
    }
    return previousStates;
  }

  projectStableVersion(parsed, version) {
    this.lastClosedUsers = [];
    this.lastTouchedIntervals = [];
    const entitiesByUser = new Map();
    for (const entity of parsed.entities) entitiesByUser.set(userKey(entity.user_id), entity);
    const previousStates = new Map(this.currentStates);
    const sameSegment = new Set();
    const dayChanged = this.lastStableVersion && this.lastStableVersion.server_day !== parsed.serverDay;
    const generationChanged = this.lastStableVersion && this.lastStableVersion.reset_generation !== parsed.resetGeneration;

    for (const [uid, previousState] of previousStates) {
      // The first steady snapshot after a reset has an empty `lastStableUsers`,
      // so gating on it dropped every player who had only appeared during the
      // warming-up phase and then vanished before the world filled back up. Those
      // players were still marked online by `projectWarmingState`, leaked into
      // the realtime map and never got closed. Anchor on the previous live state
      // instead: a player who was online in the previous frame and is now absent
      // (or the world moved to a new day/generation) must be closed.
      const wasOnline = Boolean(previousState && previousState.online);
      if (wasOnline && (!entitiesByUser.has(uid) || dayChanged || generationChanged)) {
        const interval = this.openIntervals.get(uid);
        if (interval) {
          interval.online_to_snapshot_id = this.lastStableVersion?.snapshot_id ?? version.snapshot_id;
          interval.online_to_at = this.lastStableVersion?.observed_at ?? version.observed_at;
          interval.closed_reason = dayChanged || generationChanged ? 'snapshot_boundary' : 'missing_from_steady_snapshot';
          this.openIntervals.delete(uid);
          this.lastTouchedIntervals.push(interval);
        }
        previousState.online = false;
        const player = this.players.get(uid);
        if (player) {
          player.online = false;
          this.lastClosedUsers.push(player.user_id);
        }
      }
    }

    for (const entity of parsed.entities) {
      const uid = userKey(entity.user_id);
      const previousState = previousStates.get(uid);
      const continuous = Boolean(previousState && !previousState.from_warming && this.lastStableUsers.has(uid) && !dayChanged && !generationChanged && previousState.entity_id === entity.entity_id && previousState.segment_id);
      const segmentId = continuous ? previousState.segment_id : `segment-${parsed.snapshotId}-${uid}`;
      if (continuous) sameSegment.add(uid);
      const state = { ...entity, snapshot_id: parsed.snapshotId, observed_at: version.observed_at, server_day: parsed.serverDay, reset_generation: parsed.resetGeneration, entity_id: entity.entity_id, segment_id: segmentId, online: true };
      const player = this.players.get(uid) || {
        user_id: entity.user_id,
        first_seen_at: version.observed_at,
        current_name: entity.name || '',
        current_entity_id: entity.entity_id,
        online: true
      };
      player.last_seen_at = version.observed_at;
      player.current_name = entity.name || player.current_name || '';
      player.current_entity_id = entity.entity_id;
      player.online = true;
      player.last_snapshot_id = parsed.snapshotId;
      player.segment_id = segmentId;
      this.players.set(uid, player);

      const nameKey = mapKey(uid, entity.name || '');
      const oldName = this.nameHistory.get(nameKey);
      if (oldName) oldName.last_observed_at = version.observed_at;
      else this.nameHistory.set(nameKey, {
        user_id: entity.user_id,
        name: entity.name || '',
        first_observed_at: version.observed_at,
        last_observed_at: version.observed_at
      });
      const entityKey = mapKey(uid, entity.entity_id, parsed.resetGeneration);
      const oldEntity = this.entityHistory.get(entityKey);
      if (oldEntity) {
        oldEntity.last_snapshot_id = parsed.snapshotId;
        oldEntity.last_observed_at = version.observed_at;
      } else {
        this.entityHistory.set(entityKey, {
          user_id: entity.user_id,
          entity_id: entity.entity_id,
          reset_generation: parsed.resetGeneration,
          first_snapshot_id: parsed.snapshotId,
          last_snapshot_id: parsed.snapshotId,
          first_observed_at: version.observed_at,
          last_observed_at: version.observed_at
        });
      }

      if (!continuous) {
        this.stateBases.push({
          snapshot_id: parsed.snapshotId,
          user_id: entity.user_id,
          segment_id: segmentId,
          schema_version: parsed.schemaVersion,
          state: cloneJson(entity),
          observed_at: version.observed_at
        });
        const interval = {
          user_id: entity.user_id,
          segment_id: segmentId,
          online_from_snapshot_id: parsed.snapshotId,
          online_to_snapshot_id: null,
          online_from_at: version.observed_at,
          online_to_at: null,
          server_day: parsed.serverDay
        };
        this.onlineIntervals.push(interval);
        this.openIntervals.set(uid, interval);
        this.lastTouchedIntervals.push(interval);
      } else {
        const delta = diffState(previousState, entity);
        if (delta.changedFields.length > 0) {
          this.stateDeltas.push({
            snapshot_id: parsed.snapshotId,
            user_id: entity.user_id,
            segment_id: segmentId,
            changed_mask: delta.changedMask,
            changed_values: delta.changedValues,
            missing_fields: delta.missingFields,
            extra: entity.extra || {},
            observed_at: version.observed_at
          });
        }
      }
      this.currentStates.set(uid, state);
    }

    // Capture evidence from the immediately preceding stable version. The
    // current entity set may already reflect the post-kill state.
    this.projectMessages(parsed, version, entitiesByUser, previousStates);
    this.projectDrops(parsed, version);
    this.projectQuota(parsed, version);
    this.lastStableUsers = new Set(entitiesByUser.keys());
    this.lastStableVersion = version;
  }

  resolveName(id, entitiesByUser) {
    const key = userKey(id);
    if (!key) return null;
    const entity = entitiesByUser.get(key);
    if (entity?.name) return entity.name;
    return this.players.get(key)?.current_name || null;
  }

  touchKill(kill) {
    if (kill && !this.lastTouchedKills.some(item => item.kill_id === kill.kill_id)) this.lastTouchedKills.push(kill);
  }

  projectMessages(parsed, version, entitiesByUser, evidenceStates = this.currentStates) {
    this.lastTouchedKills = [];
    for (const message of parsed.messages) {
      // Message IDs are globally stable in the observed service buffer. The
      // server day remains stored as evidence, but must not create a second
      // event when the same rolling message spans a tick reset.
      const messageKey = String(message.id);
      const old = this.messages.get(messageKey);
      if (old) {
        old.last_observed_snapshot_id = parsed.snapshotId;
        old.last_observed_at = version.observed_at;
        const oldKill = this.kills.get(messageKey);
        if (oldKill) {
          // Re-resolving only fills fields that are still missing. Handing it
          // `this.currentStates` here used to "upgrade" warming evidence to the
          // newest steady state, which for a victim means the state *after*
          // they respawned — a strictly worse reading than the one taken at
          // death.
          this.attachKillEvidence(oldKill, evidenceStates, version);
          this.touchKill(oldKill);
        }
        continue;
      }
      const namesFromText = parseKillNames(message.text);
      const killerName = this.resolveName(message.user_id, entitiesByUser) || namesFromText.killer;
      const victimName = this.resolveName(message.target_user_id, entitiesByUser) || namesFromText.victim;
      const eventAt = tickToIso(parsed.serverDay, message.tick);
      const event = {
        message_id: messageKey,
        server_day: parsed.serverDay,
        local_date: localDateFromTimestamp(eventAt) || parsed.serverDay,
        tick: message.tick,
        kind: message.kind,
        text: message.text,
        user_id: message.user_id,
        target_user_id: message.target_user_id,
        user_name: killerName,
        target_name: victimName,
        event_at: eventAt || version.observed_at,
        first_observed_snapshot_id: parsed.snapshotId,
        last_observed_snapshot_id: parsed.snapshotId,
        first_observed_at: version.observed_at,
        last_observed_at: version.observed_at
      };
      this.messages.set(messageKey, event);
      if (String(message.kind).toLowerCase() === 'kill') {
        const kill = {
          kill_id: messageKey,
          message_id: messageKey,
          local_date: event.local_date,
          event_at: event.event_at,
          server_day: parsed.serverDay,
          tick: message.tick,
          killer_user_id: message.user_id,
          victim_user_id: message.target_user_id,
          killer_name: killerName,
          victim_name: victimName,
          confidence: message.user_id !== null && message.target_user_id !== null ? 'confirmed' : 'unknown',
          evidence_snapshot_id: null,
          parser_version: SCHEMA_VERSION,
          drop: null,
          victim_position: null,
          killer_position: null,
          victim_stamina_5s: null,
          victim_stamina_5s_limit: null
        };
        this.attachKillEvidence(kill, evidenceStates, version);
        if (!kill.evidence_snapshot_id) kill.evidence_snapshot_id = parsed.snapshotId;
        this.kills.set(messageKey, kill);
        this.touchKill(kill);
        this.incrementDailyStat(message.local_date || event.local_date, message.user_id, 'kills');
        this.incrementDailyStat(message.local_date || event.local_date, message.target_user_id, 'deaths');
      }
    }
  }

  // Death evidence is a point-in-time reading. `death_drop_coins`, position and
  // stamina describe the victim as they were just before the kill, and the game
  // overwrites all three the moment they respawn — so evidence may only be taken
  // from a snapshot that genuinely precedes the kill, and once a field is
  // captured it is never rewritten. A later snapshot is more complete, not more
  // relevant.
  //
  // Both halves of that rule were wrong before. Stale state left over from the
  // previous world was accepted as "steady" evidence, which is how a kill at
  // tick 3673 was recorded with the 37 coins its victim had been carrying at
  // 23:59 the night before instead of the 465 they actually dropped.
  attachKillEvidence(kill, evidenceStates, version) {
    const victim = evidenceStates.get(userKey(kill.victim_user_id));
    const killer = evidenceStates.get(userKey(kill.killer_user_id));
    if (victim && this.precedesKill(victim, kill, version)) {
      if (!kill.victim_position) kill.victim_position = { x: numeric(victim.x), y: numeric(victim.y) };
      if (kill.victim_stamina_5s === null) kill.victim_stamina_5s = numeric(victim.stamina_5s_remaining_milli);
      if (kill.victim_stamina_5s_limit === null) kill.victim_stamina_5s_limit = numeric(victim.stamina_5s_limit_milli);
      if (!kill.evidence_snapshot_id) kill.evidence_snapshot_id = victim.snapshot_id || null;
      if (kill.drop === null && Object.prototype.hasOwnProperty.call(victim, 'death_drop_coins')) {
        kill.drop = { amount: numeric(victim.death_drop_coins), confidence: 'confirmed', evidence_snapshot_id: victim.snapshot_id || null };
      }
    }
    if (killer && !kill.killer_position && this.precedesKill(killer, kill, version)) {
      kill.killer_position = { x: numeric(killer.x), y: numeric(killer.y) };
    }
  }

  // Ticks restart with the world, so only ticks from the same world generation
  // are comparable at all. That is what rejects yesterday's leftovers; within a
  // generation the tick bound rejects anything observed after the kill,
  // respawned victims included. The calendar day is deliberately not a barrier:
  // for a kill just after midnight the nearest evidence is usually the 23:59
  // frame, same generation and a smaller tick.
  precedesKill(state, kill, version) {
    if (!state || !state.snapshot_id || !version) return false;
    if (state.reset_generation !== version.reset_generation) return false;
    const stateVersion = this.versions.find(item => item.snapshot_id === state.snapshot_id);
    if (!stateVersion || !Number.isFinite(stateVersion.server_tick) || !Number.isFinite(kill.tick)) return false;
    return stateVersion.server_tick <= kill.tick;
  }

  incrementDailyStat(localDate, id, field) {
    const uid = userKey(id);
    if (!localDate || !uid) return;
    const key = mapKey(localDate, uid);
    const stats = this.dailyStats.get(key) || { local_date: localDate, user_id: id, kills: 0, deaths: 0 };
    stats[field] += 1;
    this.dailyStats.set(key, stats);
  }

  projectDrops(parsed, version, allowDisappearance = true) {
    const touchedKeys = new Set();
    const presentKeys = new Set();
    for (const drop of parsed.drops) {
      const key = mapKey(parsed.serverDay, drop.drop_id);
      presentKeys.add(key);
      touchedKeys.add(key);
      const old = this.drops.get(key);
      if (old) {
        old.last_seen_snapshot_id = parsed.snapshotId;
        old.last_seen_at = version.observed_at;
        old.disappeared_at = null;
      } else {
        this.drops.set(key, {
          drop_id: drop.drop_id,
          server_day: parsed.serverDay,
          first_seen_snapshot_id: parsed.snapshotId,
          last_seen_snapshot_id: parsed.snapshotId,
          first_seen_at: version.observed_at,
          last_seen_at: version.observed_at,
          disappeared_at: null,
          source_user_id: drop.source_user_id,
          system_spawned: drop.system_spawned,
          x: drop.x,
          y: drop.y,
          amount: drop.amount,
          created_tick: drop.created_tick,
          source: drop.system_spawned ? 'system' : 'player',
          confidence: drop.system_spawned ? 'confirmed' : 'inferred',
          kill_event_id: null
        });
      }
    }
    for (const drop of this.drops.values()) {
      if (!allowDisappearance) continue;
      if (drop.server_day === parsed.serverDay && !presentKeys.has(mapKey(parsed.serverDay, drop.drop_id)) && !drop.disappeared_at) {
        drop.disappeared_at = version.observed_at;
        touchedKeys.add(mapKey(parsed.serverDay, drop.drop_id));
      }
    }
    for (const kill of this.kills.values()) {
      if (kill.coin_drop?.confidence === 'confirmed' || kill.server_day !== parsed.serverDay) continue;
      // The coins on the ground came out of the victim's pocket, so the drop
      // object carries the victim's user id. Matching on the killer linked
      // nothing at all — on 2026-08-26 that was 0 of 56 player drops — and it
      // also threw away the one piece of evidence that survives when the victim
      // is missing from the snapshots around their own death.
      const victimKey = userKey(kill.victim_user_id);
      const candidate = victimKey === null ? null : Array.from(this.drops.values()).find(drop => drop.server_day === parsed.serverDay && !drop.system_spawned && drop.created_tick === kill.tick && userKey(drop.source_user_id) === victimKey);
      if (candidate) {
        kill.coin_drop = { drop_id: candidate.drop_id, amount: candidate.amount, x: candidate.x, y: candidate.y, confidence: 'confirmed' };
        candidate.kill_event_id = kill.kill_id;
        candidate.confidence = 'confirmed';
        // The drop object is a direct record of what actually hit the ground,
        // so it stands in wherever the pre-death reading is missing. Where both
        // exist they agree (54 of 54 on 2026-08-26).
        if (kill.drop === null || kill.drop.amount === null) {
          kill.drop = { amount: numeric(candidate.amount), confidence: 'confirmed', evidence_snapshot_id: candidate.first_seen_snapshot_id || null, drop_id: candidate.drop_id };
        }
        this.touchKill(kill);
        touchedKeys.add(mapKey(candidate.server_day, candidate.drop_id));
      } else {
        kill.coin_drop = { drop_id: null, amount: null, x: null, y: null, confidence: 'unknown' };
      }
    }
    this.lastTouchedDrops = Array.from(touchedKeys).map(key => this.drops.get(key)).filter(Boolean);
  }

  // The game flips daily_budget_day_key_utc8 before it refills the per-day
  // entity fields, so the first frames of a new day report
  // external_balance_snapshot = 0 for players who still hold a balance. Taking
  // such a frame as the daily baseline turns the restored balance into a full
  // day of phantom income, so a zero reading that would open a new day is held
  // back until a trustworthy reading arrives. Only the baseline frames are
  // guarded — once the day has a baseline, a balance that reaches zero is
  // recorded immediately — and the hold expires so a player who really starts a
  // day at zero is still recorded.
  isRolloverZeroBalance(uid, quota, externalBalance, serverDay, observedAt) {
    const guard = this.zeroBalanceGuards.get(uid);
    const suspect = externalBalance === 0
      && Boolean(quota)
      && quota.quota_day !== serverDay
      && quota.quota_value !== null
      && quota.quota_value > 0;
    if (!suspect) {
      if (guard) this.zeroBalanceGuards.delete(uid);
      return false;
    }
    if (!guard || guard.day !== serverDay) {
      this.zeroBalanceGuards.set(uid, { day: serverDay, since: observedAt });
      return true;
    }
    if (Date.parse(observedAt) - Date.parse(guard.since) > ROLLOVER_ZERO_GUARD_MS) {
      this.zeroBalanceGuards.delete(uid);
      return false;
    }
    return true;
  }

  projectQuota(parsed, version) {
    for (const entity of parsed.entities) {
      const uid = userKey(entity.user_id);
      if (!uid) continue;
      const externalBalance = numeric(entity.external_balance_snapshot);
      const existingQuota = this.quotaCurrent.get(uid);
      if (this.isRolloverZeroBalance(uid, existingQuota, externalBalance, parsed.serverDay, version.observed_at)) continue;
      const quotaValue = externalBalance === null ? null : externalBalance / EXTERNAL_BALANCE_PER_QUOTA;
      const resetBaseline = !existingQuota || existingQuota.quota_day !== parsed.serverDay || existingQuota.quota_source !== 'external_balance_snapshot';
      let quota = existingQuota;
      if (resetBaseline) {
        quota = {
          user_id: entity.user_id,
          quota_day: parsed.serverDay,
          initial_quota: quotaValue,
          quota_value: quotaValue,
          quota_source: 'external_balance_snapshot',
          last_snapshot_id: parsed.snapshotId,
          updated_at: version.observed_at
        };
        this.quotaCurrent.set(uid, quota);
      } else {
        if (quota.initial_quota === null && quotaValue !== null) quota.initial_quota = quotaValue;
        quota.quota_value = quotaValue;
        quota.last_snapshot_id = parsed.snapshotId;
        quota.updated_at = version.observed_at;
      }
      const dailyKey = mapKey(parsed.serverDay, uid);
      const daily = this.dailyQuota.get(dailyKey) || {
        user_id: entity.user_id,
        local_date: parsed.serverDay,
        initial_quota: quota.initial_quota,
        closing_quota: quota.quota_value,
        income: quota.initial_quota !== null && quota.quota_value !== null ? quota.quota_value - quota.initial_quota : null,
        finalized_at: null,
        source_snapshot_id: parsed.snapshotId
      };
      if (resetBaseline) {
        daily.initial_quota = quotaValue;
        daily.closing_quota = quotaValue;
        daily.income = 0;
      } else if (daily.initial_quota === null && quota.initial_quota !== null) {
        daily.initial_quota = quota.initial_quota;
      }
      daily.closing_quota = quota.quota_value;
      daily.income = daily.initial_quota !== null && daily.closing_quota !== null ? daily.closing_quota - daily.initial_quota : null;
      daily.source_snapshot_id = parsed.snapshotId;
      this.dailyQuota.set(dailyKey, daily);
    }
  }

  finalizeDay(localDate, finalizedAt = new Date().toISOString()) {
    for (const daily of this.dailyQuota.values()) {
      if (daily.local_date === localDate && !daily.finalized_at) daily.finalized_at = finalizedAt;
    }
  }

  // Realtime reads resolve against the newest accepted version, warming-up
  // included. Falling back to the last steady version would answer "what is
  // happening now" with the previous day once the world resets at midnight.
  getLatestVersion() {
    const latest = this.lastVersion || this.lastStableVersion;
    return latest ? cloneJson(latest) : null;
  }

  getLatestStableVersion() {
    return this.lastStableVersion ? cloneJson(this.lastStableVersion) : null;
  }

  getVersionToken() {
    return this.getLatestVersion()?.version_token || null;
  }

  getAvailableDates() {
    return Array.from(new Set(this.versions.map(version => version.server_day))).sort();
  }

  getMeta() {
    const dates = this.getAvailableDates();
    return {
      map: cloneJson(this.mapMetadata),
      availableDates: dates,
      earliestDate: dates[0] || null,
      latestDate: dates[dates.length - 1] || null,
      presetRanges: presetRangesForDates(dates.at(-1) || null, dates),
      timezone: BUSINESS_TIMEZONE,
      schemaVersion: SCHEMA_VERSION,
      features: {
        realtime: true,
        history: true,
        chat: true,
        kills: true,
        quota: true,
        bulletHistory: false
      }
    };
  }

  currentPlayerView(uid, range = null, today = this.lastStableVersion?.server_day) {
    const player = this.players.get(uid);
    const state = this.currentStates.get(uid);
    if (!player) return null;
    const stats = this.aggregateStats(uid, range);
    const income = this.aggregateIncome(uid, range);
    const todayQuota = this.dailyQuota.get(mapKey(today, uid));
    const currentQuota = this.quotaCurrent.get(uid);
    const isTodayRange = Boolean(today && range?.from === today && range?.to === today);
    const rangedQuota = range ? this.aggregateQuota(uid, range) : null;
    const quota = range ? (rangedQuota || (isTodayRange && currentQuota ? {
      day: currentQuota.quota_day,
      initial: currentQuota.initial_quota,
      value: currentQuota.quota_value,
      income: currentQuota.initial_quota !== null && currentQuota.quota_value !== null ? currentQuota.quota_value - currentQuota.initial_quota : null
    } : null)) : (todayQuota ? {
      day: todayQuota.local_date,
      initial: todayQuota.initial_quota,
      value: todayQuota.closing_quota,
      income: todayQuota.income
    } : currentQuota ? {
      day: currentQuota.quota_day,
      initial: currentQuota.initial_quota,
      value: currentQuota.quota_value,
      income: currentQuota.initial_quota !== null && currentQuota.quota_value !== null ? currentQuota.quota_value - currentQuota.initial_quota : null
    } : null);
    const todayIncome = todayQuota && today && range?.from === today && range?.to === today ? this.aggregateIncome(uid, { from: today, to: today }) : null;
    const currentState = state && (!today || state.server_day === today) ? state : null;
    const effectiveDrop = currentState ? numeric(currentState.death_drop_coins) : null;
    return {
      userId: player.user_id,
      name: player.current_name || '',
      online: Boolean(currentState?.online && currentState.server_day === today),
      lastSeenAt: player.last_seen_at || null,
      currentEntityId: player.current_entity_id ?? null,
      drop: effectiveDrop,
      externalBalanceSnapshot: currentState ? numeric(currentState.external_balance_snapshot) : null,
      quota,
      income,
      todayIncome,
      kills: stats.kills,
      deaths: stats.deaths,
      state: currentState ? {
        hp: currentState.hp,
        maxHp: currentState.max_hp,
        x: currentState.x,
        y: currentState.y,
        invulnerableRemainingSecs: numeric(currentState.invulnerable_remaining_secs),
        loss: numeric(currentState.death_loss_preview),
        stamina5s: currentState.stamina_5s_remaining_milli,
        stamina1h: currentState.stamina_1h_remaining_milli,
        stamina1d: currentState.stamina_1d_remaining_milli,
        stamina5sLimit: currentState.stamina_5s_limit_milli,
        stamina1hLimit: currentState.stamina_1h_limit_milli,
        stamina1dLimit: currentState.stamina_1d_limit_milli,
        currentJoinMode: currentState.current_join_mode,
        life: currentState.life,
        snapshotId: currentState.snapshot_id,
        observedAt: currentState.observed_at
      } : null
    };
  }

  aggregateStats(uid, range) {
    let kills = 0;
    let deaths = 0;
    for (const stat of this.dailyStats.values()) {
      if (userKey(stat.user_id) !== uid) continue;
      if (range && (stat.local_date < range.from || stat.local_date > range.to)) continue;
      kills += stat.kills;
      deaths += stat.deaths;
    }
    return { kills, deaths };
  }

  aggregateIncome(uid, range) {
    let income = 0;
    let computable = true;
    for (const daily of this.dailyQuota.values()) {
      if (userKey(daily.user_id) !== uid) continue;
      if (range && (daily.local_date < range.from || daily.local_date > range.to)) continue;
      if (daily.income === null) computable = false;
      else income += daily.income;
    }
    return computable ? income : null;
  }

  aggregateQuota(uid, range) {
    const rows = Array.from(this.dailyQuota.values())
      .filter(daily => userKey(daily.user_id) === uid && daily.local_date >= range.from && daily.local_date <= range.to)
      .sort((a, b) => String(a.local_date).localeCompare(String(b.local_date)));
    if (rows.length === 0) return null;
    let initial = null;
    let value = null;
    let income = 0;
    let computable = true;
    for (const row of rows) {
      if (initial === null && row.initial_quota !== null) initial = row.initial_quota;
      if (row.closing_quota !== null) value = row.closing_quota;
      if (row.income === null) computable = false;
      else income += row.income;
    }
    return { day: rows.length === 1 ? rows[0].local_date : `${range.from}—${range.to}`, initial, value, income: computable ? income : null };
  }

  selectRealtimeUsers(today) {
    const views = Array.from(this.players.keys()).map(uid => this.currentPlayerView(uid, { from: today, to: today }, today)).filter(Boolean);
    // The realtime map contract is deliberately not the player-list Top50
    // union: every online player with Drop >= 1 or a non-full 1d stamina must
    // survive this server-side selection so a frontend threshold cannot hide
    // a stamina-only candidate.
    return views.filter(view => {
      const tired = Boolean(view.state && view.state.stamina1d !== null && view.state.stamina1dLimit !== null && view.state.stamina1d < view.state.stamina1dLimit);
      return view.online && ((view.drop !== null && view.drop >= 1) || tired);
    });
  }

  selectRealtimePlayers(today) {
    const views = Array.from(this.players.keys())
      .map(uid => this.currentPlayerView(uid, { from: today, to: today }, today))
      .filter(Boolean);
    const selected = new Set();
    const top = value => views
      .filter(player => value(player) !== null && value(player) !== undefined && Number.isFinite(Number(value(player))))
      .sort((a, b) => Number(value(b)) - Number(value(a)) || String(a.name).localeCompare(String(b.name)) || a.userId - b.userId)
      .slice(0, 50);
    for (const player of top(player => player.externalBalanceSnapshot)) selected.add(player.userId);
    for (const player of top(player => player.drop)) selected.add(player.userId);
    for (const player of top(player => player.todayIncome ?? player.quota?.income)) selected.add(player.userId);
    return views.filter(player => selected.has(player.userId));
  }

  getRealtime(versionToken = null) {
    const version = this.getLatestVersion();
    if (!version) return { unchanged: false, versionToken: null, latest: null, players: [], messages: [], kills: [], generatedAt: new Date().toISOString() };
    if (versionToken && versionToken === version.version_token) return { unchanged: true, versionToken: version.version_token, generatedAt: new Date().toISOString() };
    const today = version.server_day;
    const players = this.selectRealtimeUsers(today);
    const messages = Array.from(this.messages.values()).filter(message => message.local_date === today).sort((a, b) => String(a.event_at).localeCompare(String(b.event_at)) || String(a.server_day).localeCompare(String(b.server_day)) || String(a.message_id).localeCompare(String(b.message_id)));
    const kills = Array.from(this.kills.values()).filter(kill => kill.local_date === today).sort((a, b) => String(a.event_at).localeCompare(String(b.event_at)) || String(a.local_date).localeCompare(String(b.local_date)) || String(a.kill_id).localeCompare(String(b.kill_id)));
    return {
      unchanged: false,
      versionToken: version.version_token,
      generatedAt: new Date().toISOString(),
      latest: cloneJson(version),
      map: cloneJson(this.mapMetadata),
      players: cloneJson(players),
      messages: cloneJson(messages),
      kills: cloneJson(kills),
      quota: cloneJson(Array.from(this.quotaCurrent.values()).filter(item => item.quota_day === today)),
      stats: cloneJson(Array.from(this.dailyStats.values()).filter(item => item.local_date === today)),
      closedThrough: null
    };
  }

  getHistory(range) {
    const messages = Array.from(this.messages.values()).filter(message => message.local_date >= range.from && message.local_date <= range.to).sort((a, b) => String(a.event_at).localeCompare(String(b.event_at)) || String(a.server_day).localeCompare(String(b.server_day)) || String(a.message_id).localeCompare(String(b.message_id)));
    const kills = Array.from(this.kills.values()).filter(kill => kill.local_date >= range.from && kill.local_date <= range.to).sort((a, b) => String(a.event_at).localeCompare(String(b.event_at)) || String(a.local_date).localeCompare(String(b.local_date)) || String(a.kill_id).localeCompare(String(b.kill_id)));
    const players = sortNames(this.selectHistoryUsers(range, this.lastStableVersion?.server_day));
    const dailyQuota = Array.from(this.dailyQuota.values()).filter(item => item.local_date >= range.from && item.local_date <= range.to).sort((a, b) => String(a.local_date).localeCompare(String(b.local_date)) || Number(a.user_id) - Number(b.user_id)).map(historyQuotaView);
    const stats = Array.from(this.dailyStats.values()).filter(item => item.local_date >= range.from && item.local_date <= range.to).sort((a, b) => String(a.local_date).localeCompare(String(b.local_date)) || Number(a.user_id) - Number(b.user_id)).map(historyStatView);
    const latest = this.lastStableVersion?.server_day || null;
    return {
      from: range.from,
      to: range.to,
      timezone: BUSINESS_TIMEZONE,
      generatedAt: new Date().toISOString(),
      closedThrough: latest && range.to < latest ? range.to : null,
      players: cloneJson(players),
      messages: cloneJson(messages),
      kills: cloneJson(kills),
      dailyQuota: cloneJson(dailyQuota),
      stats: cloneJson(stats)
    };
  }

  getRealtimeResource(resource, versionToken = null) {
    const version = this.getLatestVersion();
    if (!version) {
      const empty = { unchanged: false, versionToken: null, latest: null, serverDay: null };
      if (resource === 'chat') empty.messages = [];
      if (resource === 'map') { empty.map = cloneJson(this.mapMetadata); empty.players = []; }
      if (resource === 'players') empty.players = [];
      if (resource === 'kills') empty.kills = [];
      return empty;
    }
    if (versionToken && versionToken === version.version_token) return { unchanged: true, versionToken: version.version_token };
    const latest = cloneJson(version);
    const common = {
      versionToken: version.version_token,
      latest,
      serverDay: latest?.server_day || null
    };
    const today = version.server_day;
    const messages = () => Array.from(this.messages.values())
      .filter(message => message.local_date === today)
      .sort((a, b) => String(a.event_at).localeCompare(String(b.event_at)) || String(a.server_day).localeCompare(String(b.server_day)) || String(a.message_id).localeCompare(String(b.message_id)));
    const kills = () => Array.from(this.kills.values())
      .filter(kill => kill.local_date === today)
      .sort((a, b) => String(a.event_at).localeCompare(String(b.event_at)) || String(a.local_date).localeCompare(String(b.local_date)) || String(a.kill_id).localeCompare(String(b.kill_id)));
    switch (resource) {
      case 'chat':
        return { ...common, messages: cloneJson(messages()) };
      case 'map':
        return { ...common, map: cloneJson(this.mapMetadata), players: cloneJson(this.selectRealtimeUsers(today).map(mapPlayerView)) };
      case 'players':
        return { ...common, players: latest ? cloneJson(this.selectRealtimePlayers(latest.server_day)) : [] };
      case 'kills':
        return { ...common, kills: cloneJson(kills()) };
      default:
        throw new Error(`unknown realtime resource: ${resource}`);
    }
  }

  getRealtimeChat(versionToken = null) { return this.getRealtimeResource('chat', versionToken); }
  getRealtimeMap(versionToken = null) { return this.getRealtimeResource('map', versionToken); }
  getRealtimePlayers(versionToken = null) { return this.getRealtimeResource('players', versionToken); }
  getRealtimeKills(versionToken = null) { return this.getRealtimeResource('kills', versionToken); }

  getHistoryResource(resource, range) {
    const messages = Array.from(this.messages.values())
      .filter(message => message.local_date >= range.from && message.local_date <= range.to)
      .sort((a, b) => String(a.event_at).localeCompare(String(b.event_at)) || String(a.server_day).localeCompare(String(b.server_day)) || String(a.message_id).localeCompare(String(b.message_id)));
    const kills = Array.from(this.kills.values())
      .filter(kill => kill.local_date >= range.from && kill.local_date <= range.to)
      .sort((a, b) => String(a.event_at).localeCompare(String(b.event_at)) || String(a.local_date).localeCompare(String(b.local_date)) || String(a.kill_id).localeCompare(String(b.kill_id)));
    const latest = this.lastStableVersion?.server_day || null;
    const common = { from: range.from, to: range.to, closedThrough: latest && range.to < latest ? range.to : null };
    switch (resource) {
      case 'chat':
        return { ...common, messages: cloneJson(messages) };
      case 'players':
        return { ...common, players: cloneJson(sortNames(this.selectHistoryUsers(range, latest))) };
      case 'kills':
        return { ...common, kills: cloneJson(kills) };
      default:
        throw new Error(`unknown history resource: ${resource}`);
    }
  }

  getHistoryChat(range) { return this.getHistoryResource('chat', range); }
  getHistoryPlayers(range) { return this.getHistoryResource('players', range); }
  getHistoryKills(range) { return this.getHistoryResource('kills', range); }

  selectHistoryUsers(range, today = this.lastStableVersion?.server_day) {
    const views = Array.from(this.players.keys())
      .map(uid => this.currentPlayerView(uid, range, today))
      .filter(Boolean);
    const selected = new Set();
    const top = value => views
      .filter(player => value(player) !== null && value(player) !== undefined && Number.isFinite(Number(value(player))))
      .sort((a, b) => Number(value(b)) - Number(value(a)) || String(a.name).localeCompare(String(b.name)) || a.userId - b.userId)
      .slice(0, 50);
    for (const player of top(player => player.quota?.value)) selected.add(player.userId);
    for (const player of top(player => player.drop)) selected.add(player.userId);
    for (const player of top(player => player.income)) selected.add(player.userId);
    return views.filter(player => selected.has(player.userId));
  }

  rebuildCurrentAt(snapshotId = null) {
    const bases = new Map();
    const ordered = this.versions.filter(v => v.completeness === 'steady').map(v => v.snapshot_id);
    const limit = snapshotId ? ordered.indexOf(snapshotId) : ordered.length - 1;
    const allowed = new Set(ordered.slice(0, limit < 0 ? ordered.length : limit + 1));
    const order = new Map(ordered.map((id, index) => [id, index]));
    const records = [
      ...this.stateBases.map(record => ({ kind: 'base', record })),
      ...this.stateDeltas.map(record => ({ kind: 'delta', record }))
    ].filter(item => allowed.has(item.record.snapshot_id)).sort((a, b) => order.get(a.record.snapshot_id) - order.get(b.record.snapshot_id));
    for (const item of records) {
      const record = item.record;
      const uid = userKey(record.user_id);
      if (item.kind === 'base') {
        bases.set(uid, { ...cloneJson(record.state), segment_id: record.segment_id, snapshot_id: record.snapshot_id });
        continue;
      }
      const state = bases.get(uid);
      if (!state || state.segment_id !== record.segment_id) continue;
      for (const [field, value] of Object.entries(record.changed_values)) state[field] = cloneJson(value);
      for (const field of record.missing_fields || []) delete state[field];
      if ((record.changed_mask || []).includes('extra')) state.extra = cloneJson(record.extra || {});
      state.snapshot_id = record.snapshot_id;
    }
    return bases;
  }

  verifyRebuild() {
    const rebuilt = this.rebuildCurrentAt();
    const mismatches = [];
    for (const [uid, state] of this.currentStates) {
      // Warming-up states are display-only and deliberately never written to the
      // base/delta chain, so they are not rebuildable by construction.
      if (state.from_warming) continue;
      const copy = { ...state };
      delete copy.online;
      delete copy.observed_at;
      delete copy.server_day;
      delete copy.reset_generation;
      delete copy.segment_id;
      delete copy.snapshot_id;
      const actual = rebuilt.get(uid);
      if (!actual) {
        mismatches.push({ user_id: uid, reason: 'missing_rebuilt_state' });
        continue;
      }
      const actualCopy = { ...actual };
      delete actualCopy.segment_id;
      delete actualCopy.snapshot_id;
      if (!isDeepStrictEqual(copy, actualCopy)) mismatches.push({ user_id: uid, reason: 'state_difference' });
    }
    return { ok: mismatches.length === 0, mismatches, checkedUsers: this.currentStates.size };
  }

  health() {
    // Staleness measures whether ingestion is still advancing, so it tracks the
    // newest version. Gating it on steadiness turned every world reset into a
    // false "stale" alarm for as long as the world took to repopulate.
    const latest = this.lastVersion || this.lastStableVersion;
    const now = Date.now();
    return {
      latestStableVersionAgeMs: latest ? Math.max(0, now - Date.parse(latest.observed_at)) : null,
      queueDepth: 0,
      availableEgressGroups: null,
      coolingEgressCount: null,
      consecutiveFailures: 0,
      diskFreeBytes: null,
      latestVersion: latest?.version_token || null
    };
  }
}

module.exports = {
  ProjectionEngine,
  DEFAULT_MAP_METADATA,
  loadMapMetadata
};
