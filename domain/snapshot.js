'use strict';

const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');

const BUSINESS_TIMEZONE = 'Asia/Shanghai';
const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 50;
const DEFAULT_MIN_STEADY_ENTITIES = 900;
const MAX_HISTORY_DAYS = 62;
const SCHEMA_VERSION = 'snapshot-v1';
const DATE_PRESET_KEYS = Object.freeze(['today', 'yesterday', 'this-week', 'last-week', 'this-month', 'last-month']);

const NUMERIC_ENTITY_FIELDS = [
  'entity_id', 'user_id', 'x', 'y', 'vx', 'vy', 'hp', 'max_hp',
  'invulnerable_until_tick', 'invulnerable_remaining_ticks',
  'invulnerable_remaining_secs', 'stamina_5s_remaining_milli',
  'stamina_1h_remaining_milli', 'stamina_1d_remaining_milli',
  'stamina_5s_limit_milli', 'stamina_1h_limit_milli', 'stamina_1d_limit_milli',
  'coins', 'death_drop_coins', 'death_reward_preview', 'death_loss_preview',
  'death_total_loss_preview', 'daily_budget_day_key_utc8',
  'external_balance_snapshot', 'coin_value_snapshot', 'reward_pool_limit',
  'reward_dropped_today', 'reward_remaining_today', 'death_loss_pool_limit',
  'death_lost_today', 'death_loss_remaining_today', 'active_join_count',
  'passive_join_count', 'death_count', 'waiting_revive_count', 'revive_at_tick'
];

const BOOLEAN_ENTITY_FIELDS = ['waiting_revive'];
const STRING_ENTITY_FIELDS = ['name', 'visible', 'joined', 'current_join_mode', 'life'];
const ARRAY_ENTITY_FIELDS = ['cell', 'active_join_ticks', 'passive_join_ticks', 'death_ticks'];
const ENTITY_FIELDS = [
  ...NUMERIC_ENTITY_FIELDS,
  ...BOOLEAN_ENTITY_FIELDS,
  ...STRING_ENTITY_FIELDS,
  ...ARRAY_ENTITY_FIELDS
];

const REQUIRED_ENTITY_FIELDS = ENTITY_FIELDS;
const STATE_FIELDS = ENTITY_FIELDS;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value) {
  return Number.isInteger(value);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function localDateFromTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function dateFromDayKey(dayKey) {
  if (!isInteger(dayKey)) return null;
  return new Date(dayKey * DAY_MS).toISOString().slice(0, 10);
}

function dateToUtcStart(dateString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString || '');
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - (8 * 60 * 60 * 1000);
}

function tickToDate(serverDay, tick) {
  const start = dateToUtcStart(serverDay);
  if (!Number.isFinite(start) || !isFiniteNumber(Number(tick))) return null;
  return new Date(start + Number(tick) * TICK_MS);
}

function tickToIso(serverDay, tick) {
  const date = tickToDate(serverDay, tick);
  return date ? date.toISOString() : null;
}

function hashBody(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function typeError(path, expected, value) {
  return `${path} must be ${expected}; got ${value === null ? 'null' : typeof value}`;
}

function validateEntity(entity, index) {
  const errors = [];
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
    return [`entities[${index}] must be an object`];
  }
  for (const field of REQUIRED_ENTITY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(entity, field)) {
      errors.push(`entities[${index}].${field} is missing`);
    }
  }
  for (const field of NUMERIC_ENTITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(entity, field) && entity[field] !== null && !isFiniteNumber(entity[field])) {
      errors.push(typeError(`entities[${index}].${field}`, 'a finite number or null', entity[field]));
    }
  }
  for (const field of BOOLEAN_ENTITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(entity, field) && entity[field] !== null && typeof entity[field] !== 'boolean') {
      errors.push(typeError(`entities[${index}].${field}`, 'a boolean or null', entity[field]));
    }
  }
  for (const field of STRING_ENTITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(entity, field) && entity[field] !== null && typeof entity[field] !== 'string') {
      errors.push(typeError(`entities[${index}].${field}`, 'a string or null', entity[field]));
    }
  }
  for (const field of ARRAY_ENTITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(entity, field) && entity[field] !== null && !Array.isArray(entity[field])) {
      errors.push(typeError(`entities[${index}].${field}`, 'an array or null', entity[field]));
    }
  }
  if (entity.entity_id === null || entity.user_id === null) {
    errors.push(`entities[${index}] identity fields cannot be null`);
  }
  if (Array.isArray(entity.cell) && entity.cell.length !== 2) {
    errors.push(`entities[${index}].cell must contain two coordinates`);
  }
  return errors;
}

function validateMessage(message, index) {
  const errors = [];
  if (!message || typeof message !== 'object' || Array.isArray(message)) return [`messages[${index}] must be an object`];
  if (!isFiniteNumber(message.id)) errors.push(typeError(`messages[${index}].id`, 'a finite number', message.id));
  if (!isFiniteNumber(message.tick)) errors.push(typeError(`messages[${index}].tick`, 'a finite number', message.tick));
  if (typeof message.kind !== 'string') errors.push(typeError(`messages[${index}].kind`, 'a string', message.kind));
  if (typeof message.text !== 'string') errors.push(typeError(`messages[${index}].text`, 'a string', message.text));
  for (const field of ['user_id', 'target_user_id']) {
    if (message[field] !== undefined && message[field] !== null && !isFiniteNumber(message[field])) {
      errors.push(typeError(`messages[${index}].${field}`, 'a finite number, null, or omission', message[field]));
    }
  }
  return errors;
}

function validateDrop(drop, index) {
  const errors = [];
  if (!drop || typeof drop !== 'object' || Array.isArray(drop)) return [`coin_drops[${index}] must be an object`];
  for (const field of ['drop_id', 'source_user_id', 'x', 'y', 'amount', 'created_tick']) {
    if (!isFiniteNumber(drop[field])) errors.push(typeError(`coin_drops[${index}].${field}`, 'a finite number', drop[field]));
  }
  if (typeof drop.system_spawned !== 'boolean') errors.push(typeError(`coin_drops[${index}].system_spawned`, 'a boolean', drop.system_spawned));
  return errors;
}

function normaliseEntity(entity) {
  const normalized = {};
  for (const field of ENTITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(entity, field)) normalized[field] = cloneJson(entity[field]);
  }
  const known = new Set(ENTITY_FIELDS);
  const extra = {};
  for (const [key, value] of Object.entries(entity)) {
    if (!known.has(key)) extra[key] = cloneJson(value);
  }
  normalized.extra = extra;
  return normalized;
}

function normaliseMessage(message) {
  return {
    id: message.id,
    tick: message.tick,
    kind: message.kind,
    user_id: message.user_id ?? null,
    target_user_id: message.target_user_id ?? null,
    text: message.text
  };
}

function normaliseDrop(drop) {
  return {
    drop_id: drop.drop_id,
    source_user_id: drop.source_user_id,
    system_spawned: drop.system_spawned,
    x: drop.x,
    y: drop.y,
    amount: drop.amount,
    created_tick: drop.created_tick
  };
}

function parseSnapshot(body, options = {}) {
  const payloadHash = options.payloadHash || hashBody(body);
  let payload;
  const errors = [];
  try {
    payload = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
  } catch (error) {
    return {
      valid: false,
      completeness: 'invalid',
      parseStatus: 'invalid',
      schemaVersion: SCHEMA_VERSION,
      payloadHash,
      errors: [`invalid JSON: ${error.message}`]
    };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) errors.push('top-level JSON must be an object');
  const top = payload && typeof payload === 'object' ? payload : {};
  if (top.type !== undefined && top.type !== 'snapshot') errors.push('type must be snapshot');
  if (!isFiniteNumber(top.tick)) errors.push(typeError('tick', 'a finite number', top.tick));
  for (const field of ['total_entities', 'in_game', 'visible', 'occupied_cells']) {
    if (!isFiniteNumber(top[field])) errors.push(typeError(field, 'a finite number', top[field]));
  }
  for (const field of ['entities', 'bullets', 'coin_drops', 'messages']) {
    if (!Array.isArray(top[field])) errors.push(`${field} must be an array`);
  }
  const entities = Array.isArray(top.entities) ? top.entities : [];
  const entityIds = new Set();
  const userIds = new Set();
  entities.forEach((entity, index) => {
    errors.push(...validateEntity(entity, index));
    if (entity && entity.entity_id !== undefined) {
      if (entityIds.has(entity.entity_id)) errors.push(`duplicate entity_id ${entity.entity_id}`);
      entityIds.add(entity.entity_id);
    }
    if (entity && entity.user_id !== undefined) {
      if (userIds.has(entity.user_id)) errors.push(`duplicate user_id ${entity.user_id}`);
      userIds.add(entity.user_id);
    }
  });
  const messages = Array.isArray(top.messages) ? top.messages : [];
  messages.forEach((message, index) => errors.push(...validateMessage(message, index)));
  const drops = Array.isArray(top.coin_drops) ? top.coin_drops : [];
  drops.forEach((drop, index) => errors.push(...validateDrop(drop, index)));
  if (Array.isArray(top.entities) && top.in_game !== undefined && top.in_game !== entities.length) {
    errors.push('entities and in_game counts differ');
  }
  if (Array.isArray(top.entities) && top.visible !== undefined && top.visible !== entities.length) {
    errors.push('entities and visible counts differ');
  }
  const firstDayKey = entities.find(entity => isInteger(entity?.daily_budget_day_key_utc8))?.daily_budget_day_key_utc8;
  const observedAt = options.observedAt || new Date();
  const serverDay = dateFromDayKey(firstDayKey) || localDateFromTimestamp(observedAt);
  const previous = options.previous || null;
  const resetGeneration = previous && isFiniteNumber(top.tick) && Number(top.tick) < Number(previous.serverTick)
    ? Number(previous.resetGeneration || 0) + 1
    : Number(previous?.resetGeneration || 0);
  const configuredMinSteadyEntities = options.minSteadyEntities === undefined || options.minSteadyEntities === null
    ? DEFAULT_MIN_STEADY_ENTITIES
    : Number(options.minSteadyEntities);
  const minSteadyEntities = Number.isFinite(configuredMinSteadyEntities) ? configuredMinSteadyEntities : DEFAULT_MIN_STEADY_ENTITIES;
  const completeness = errors.length > 0
    ? 'invalid'
    : entities.length < minSteadyEntities
      ? 'warming_up'
      : 'steady';
  const normalizedEntities = entities.map(normaliseEntity);
  const normalizedMessages = messages.map(normaliseMessage);
  const normalizedDrops = drops.map(normaliseDrop);
  const snapshotKey = `${serverDay}/${resetGeneration}/${top.tick}/${payloadHash}`;
  const snapshotId = `snap-${crypto.createHash('sha256').update(snapshotKey).digest('hex').slice(0, 24)}`;
  return {
    valid: completeness !== 'invalid',
    complete: completeness === 'steady',
    completeness,
    parseStatus: completeness === 'invalid' ? 'invalid' : 'parsed',
    schemaVersion: SCHEMA_VERSION,
    payloadHash,
    serverDay,
    resetGeneration,
    serverTick: top.tick ?? null,
    snapshotId,
    snapshotKey,
    observedAt: new Date(observedAt).toISOString(),
    entityCount: entities.length,
    totalEntities: top.total_entities ?? null,
    bulletCount: Array.isArray(top.bullets) ? top.bullets.length : null,
    coinDropCount: drops.length,
    messageCount: messages.length,
    entities: normalizedEntities,
    messages: normalizedMessages,
    drops: normalizedDrops,
    occupiedCells: top.occupied_cells ?? null,
    errors,
    raw: {
      type: top.type ?? null,
      in_game: top.in_game ?? null,
      visible: top.visible ?? null
    }
  };
}

function diffState(previous, current) {
  const changedFields = [];
  const changedValues = {};
  const missingFields = [];
  for (const field of STATE_FIELDS) {
    const previousHas = previous && Object.prototype.hasOwnProperty.call(previous, field);
    const currentHas = Object.prototype.hasOwnProperty.call(current, field);
    const previousValue = previousHas ? previous[field] : undefined;
    const currentValue = currentHas ? current[field] : undefined;
    if (JSON.stringify(previousValue) !== JSON.stringify(currentValue) || previousHas !== currentHas) {
      changedFields.push(field);
      if (currentHas) changedValues[field] = cloneJson(currentValue);
      else missingFields.push(field);
    }
  }
  const previousExtra = previous?.extra || {};
  const currentExtra = current?.extra || {};
  if (!isDeepStrictEqual(previousExtra, currentExtra)) {
    changedFields.push('extra');
  }
  return { changedFields, changedValues, missingFields, changedMask: changedFields.slice() };
}

function businessDateRange(from, to) {
  const parseDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return NaN;
    const timestamp = dateToUtcStart(value);
    const [year, month, day] = value.split('-').map(Number);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    if (!Number.isFinite(timestamp) || calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() + 1 !== month || calendarDate.getUTCDate() !== day) return NaN;
    return timestamp;
  };
  const fromTimestamp = parseDate(from);
  const toTimestamp = parseDate(to);
  if (!Number.isFinite(fromTimestamp) || !Number.isFinite(toTimestamp) || from > to) throw new Error('date range must be YYYY-MM-DD with from <= to');
  const days = Math.floor((toTimestamp - fromTimestamp) / DAY_MS) + 1;
  if (days > MAX_HISTORY_DAYS) throw new Error(`date range cannot exceed ${MAX_HISTORY_DAYS} days`);
  return { from, to };
}

function addDays(dateString, amount) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString || '');
  const offset = Number(amount);
  if (!match || !Number.isFinite(offset)) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function presetRangesForDates(latestDate, availableDates = []) {
  const ranges = Object.fromEntries(DATE_PRESET_KEYS.map(key => [key, null]));
  if (!latestDate || !Array.isArray(availableDates) || availableDates.length === 0) return ranges;
  const latest = new Date(`${latestDate}T00:00:00Z`);
  if (Number.isNaN(latest.getTime())) return ranges;
  const day = (latest.getUTCDay() + 6) % 7;
  const monthStart = `${latestDate.slice(0, 7)}-01`;
  const rawRanges = {
    today: { from: latestDate, to: latestDate },
    yesterday: { from: addDays(latestDate, -1), to: addDays(latestDate, -1) },
    'this-week': { from: addDays(latestDate, -day), to: latestDate },
    'last-week': { from: addDays(latestDate, -day - 7), to: addDays(latestDate, -day - 1) },
    'this-month': { from: monthStart, to: latestDate },
    'last-month': { from: `${addDays(monthStart, -1).slice(0, 7)}-01`, to: addDays(monthStart, -1) }
  };
  const available = new Set(availableDates.map(value => String(value).slice(0, 10)));
  const covered = range => {
    if (!range?.from || !range?.to || range.from > range.to) return null;
    for (let date = range.from; date <= range.to; date = addDays(date, 1)) {
      if (!available.has(date)) return null;
    }
    return range;
  };
  for (const key of DATE_PRESET_KEYS) ranges[key] = covered(rawRanges[key]);
  return ranges;
}

module.exports = {
  BUSINESS_TIMEZONE,
  DAY_MS,
  TICK_MS,
  DEFAULT_MIN_STEADY_ENTITIES,
  MAX_HISTORY_DAYS,
  SCHEMA_VERSION,
  ENTITY_FIELDS,
  STATE_FIELDS,
  NUMERIC_ENTITY_FIELDS,
  parseSnapshot,
  normaliseEntity,
  diffState,
  hashBody,
  localDateFromTimestamp,
  dateFromDayKey,
  dateToUtcStart,
  tickToDate,
  tickToIso,
  businessDateRange,
  addDays,
  DATE_PRESET_KEYS,
  presetRangesForDates,
  cloneJson
};
