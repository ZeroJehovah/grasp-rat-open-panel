'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_EGRESSES = [
  { id: 'A1', group: 'A' },
  { id: 'B1', group: 'B' },
  { id: 'A2', group: 'A' },
  { id: 'B2', group: 'B' }
];

const DEFAULT_MIN_IP_INTERVAL_MS = 30_001;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_MAX_COOLDOWN_MS = 60 * 60_000;

function atomicWriteJson(filePath, value, mode = 0o600) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'wx', mode);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, filePath);
  try { fs.chmodSync(filePath, mode); } catch (_) { /* best effort on unusual filesystems */ }
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}

function normalizeEgresses(value) {
  let entries = value;
  if (typeof value === 'string') {
    try { entries = JSON.parse(value); } catch (_) { entries = null; }
  }
  if (!Array.isArray(entries) || entries.length === 0) entries = DEFAULT_EGRESSES;
  const normalized = entries.map((entry, index) => ({
    id: String(entry.id || entry.egress_id || `egress-${index + 1}`),
    group: String(entry.group || entry.egress_group || (index % 2 === 0 ? 'A' : 'B')).toUpperCase(),
    localAddress: entry.localAddress || entry.local_address || undefined,
    proxy: entry.proxy || undefined
  })).filter(entry => entry.id && (entry.group === 'A' || entry.group === 'B'));
  return normalized.length ? normalized : DEFAULT_EGRESSES.slice();
}

function loadEgresses(options = {}) {
  if (options.egresses) return normalizeEgresses(options.egresses);
  if (options.egressConfigPath) return normalizeEgresses(readJson(options.egressConfigPath, null));
  if (process.env.GRASP_RAT_PANEL_EGRESS_JSON) return normalizeEgresses(process.env.GRASP_RAT_PANEL_EGRESS_JSON);
  return DEFAULT_EGRESSES.slice();
}

function classifyFailure(result, error = null) {
  const status = result?.statusCode || 0;
  const body = Buffer.isBuffer(result?.body) ? result.body.toString('utf8', 0, 4096).toLowerCase() : '';
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  if (status === 403 || status === 429 || /captcha|verify you are human|access denied|forbidden|cf-chl|cloudflare/.test(body)) return 'risk_control';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timeout/.test(message)) return 'timeout';
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || /policy|proxy|refused/.test(message)) return 'policy_rejected';
  if (status >= 500 || status === 0) return 'upstream_error';
  if (status >= 400) return 'http_error';
  return null;
}

class EgressScheduler {
  constructor(options = {}) {
    this.egresses = normalizeEgresses(options.egresses || loadEgresses(options));
    this.statePath = options.statePath || options.stateFile || null;
    this.minIpIntervalMs = Number(options.minIpIntervalMs || DEFAULT_MIN_IP_INTERVAL_MS);
    this.cooldownMs = Number(options.cooldownMs || DEFAULT_COOLDOWN_MS);
    this.maxCooldownMs = Number(options.maxCooldownMs || DEFAULT_MAX_COOLDOWN_MS);
    const initial = { nextGroup: 'A', consecutiveFailures: 0, egresses: {} };
    this.state = readJson(this.statePath, initial);
    if (!this.state.egresses || typeof this.state.egresses !== 'object') this.state = initial;
    for (const egress of this.egresses) {
      if (!this.state.egresses[egress.id]) this.state.egresses[egress.id] = {
        id: egress.id,
        group: egress.group,
        last_attempt_at: null,
        next_eligible_at: 0,
        last_success_at: null,
        cooldown_until: 0,
        cooldown_reason: null,
        consecutive_failures: 0,
        last_version: null
      };
    }
    this.persist();
  }

  persist() {
    if (this.statePath) atomicWriteJson(this.statePath, this.state);
  }

  stateFor(egress) {
    return this.state.egresses[egress.id];
  }

  choose(group, now = Date.now(), excluded = new Set()) {
    const candidates = this.egresses.filter(egress => {
      const state = this.stateFor(egress);
      return egress.group === group && !excluded.has(egress.id) && state && now >= Number(state.next_eligible_at || 0) && now >= Number(state.cooldown_until || 0);
    });
    candidates.sort((a, b) => {
      const sa = this.stateFor(a);
      const sb = this.stateFor(b);
      return Number(sa.last_attempt_at || 0) - Number(sb.last_attempt_at || 0) || a.id.localeCompare(b.id);
    });
    return candidates[0] || null;
  }

  chooseNext(now = Date.now(), excluded = new Set()) {
    const first = this.state.nextGroup === 'A' ? 'A' : 'B';
    const second = first === 'A' ? 'B' : 'A';
    return this.choose(first, now, excluded) || this.choose(second, now, excluded);
  }

  markAttempt(egress, now = Date.now()) {
    const state = this.stateFor(egress);
    state.last_attempt_at = now;
    state.next_eligible_at = now + this.minIpIntervalMs;
    this.persist();
  }

  markResult(egress, result, now = Date.now(), error = null) {
    const state = this.stateFor(egress);
    const failureCategory = classifyFailure(result, error);
    if (!failureCategory && result?.statusCode >= 200 && result.statusCode < 300) {
      state.last_success_at = now;
      state.cooldown_until = 0;
      state.cooldown_reason = null;
      state.consecutive_failures = 0;
      state.last_version = result.versionToken || result.payloadHash || null;
      this.state.consecutiveFailures = 0;
    } else {
      state.consecutive_failures = Number(state.consecutive_failures || 0) + 1;
      this.state.consecutiveFailures = Number(this.state.consecutiveFailures || 0) + 1;
      if (failureCategory === 'risk_control' || failureCategory === 'policy_rejected' || failureCategory === 'timeout') {
        const cooldown = Math.min(this.maxCooldownMs, this.cooldownMs * (2 ** Math.max(0, state.consecutive_failures - 1)));
        state.cooldown_until = now + cooldown;
        state.cooldown_reason = failureCategory;
      }
    }
    this.state.nextGroup = egress.group === 'A' ? 'B' : 'A';
    this.persist();
    return failureCategory;
  }

  nextEligibleAt(now = Date.now()) {
    return Math.min(...this.egresses.map(egress => {
      const state = this.stateFor(egress);
      return Math.max(Number(state.next_eligible_at || 0), Number(state.cooldown_until || 0), now);
    }));
  }

  health(now = Date.now()) {
    let availableA = 0;
    let availableB = 0;
    let cooling = 0;
    for (const egress of this.egresses) {
      const state = this.stateFor(egress);
      if (Number(state.cooldown_until || 0) > now) cooling += 1;
      else if (Number(state.next_eligible_at || 0) <= now) {
        if (egress.group === 'A') availableA += 1;
        else availableB += 1;
      }
    }
    return {
      availableEgressGroups: { A: availableA, B: availableB },
      coolingEgressCount: cooling,
      consecutiveFailures: Number(this.state.consecutiveFailures || 0),
      nextEligibleAt: this.nextEligibleAt(now)
    };
  }
}

module.exports = {
  DEFAULT_EGRESSES,
  DEFAULT_MIN_IP_INTERVAL_MS,
  normalizeEgresses,
  loadEgresses,
  classifyFailure,
  EgressScheduler,
  atomicWriteJson
};
