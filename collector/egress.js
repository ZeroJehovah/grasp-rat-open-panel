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
const DEFAULT_ACTIVE_PER_GROUP = 2;
const DEFAULT_ACTIVE_COUNT = 4;
const DEFAULT_BENCHMARK_RETRY_MS = 5 * 60_000;

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
  if (entries && !Array.isArray(entries) && typeof entries === 'object') {
    entries = entries.egresses || entries.candidates || entries.items;
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

function normalizeEgressPlan(value) {
  let config = value;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch (_) { config = null; }
  }
  const isObjectConfig = config && !Array.isArray(config) && typeof config === 'object';
  const selection = isObjectConfig && config.selection && typeof config.selection === 'object'
    ? config.selection
    : {};
  const egresses = normalizeEgresses(config);
  const activePerGroup = Number(selection.activePerGroup || config?.activePerGroup || DEFAULT_ACTIVE_PER_GROUP);
  const activeCount = Number(selection.activeCount || config?.activeCount || DEFAULT_ACTIVE_COUNT);
  return {
    egresses,
    dailyBenchmark: Boolean(isObjectConfig && (config.dailyBenchmark || selection.mode === 'daily-fastest')),
    activePerGroup: Number.isFinite(activePerGroup) && activePerGroup > 0 ? Math.floor(activePerGroup) : DEFAULT_ACTIVE_PER_GROUP,
    activeCount: Number.isFinite(activeCount) && activeCount > 0 ? Math.floor(activeCount) : DEFAULT_ACTIVE_COUNT,
    benchmarkRetryMs: Number.isFinite(Number(selection.retryMs || config?.benchmarkRetryMs))
      ? Math.max(1_000, Number(selection.retryMs || config.benchmarkRetryMs))
      : DEFAULT_BENCHMARK_RETRY_MS
  };
}

function readConfiguredEgressValue(options = {}) {
  if (options.egressPlan) return options.egressPlan;
  if (options.egresses) return options.egresses;
  if (options.egressConfigPath) return readJson(options.egressConfigPath, null);
  if (process.env.GRASP_RAT_PANEL_EGRESS_JSON) return process.env.GRASP_RAT_PANEL_EGRESS_JSON;
  return DEFAULT_EGRESSES;
}

function loadEgressPlan(options = {}) {
  return normalizeEgressPlan(readConfiguredEgressValue(options));
}

function loadEgresses(options = {}) {
  return loadEgressPlan(options).egresses;
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
    const plan = options.egressPlan || loadEgressPlan(options);
    this.egresses = normalizeEgresses(options.egresses || plan.egresses);
    this.dailyBenchmark = options.dailyBenchmark === undefined ? plan.dailyBenchmark : Boolean(options.dailyBenchmark);
    this.activePerGroup = Number(options.activePerGroup || plan.activePerGroup || DEFAULT_ACTIVE_PER_GROUP);
    this.activeCount = Number(options.activeCount || plan.activeCount || DEFAULT_ACTIVE_COUNT);
    this.benchmarkRetryMs = Number(options.benchmarkRetryMs || plan.benchmarkRetryMs || DEFAULT_BENCHMARK_RETRY_MS);
    this.statePath = options.statePath || options.stateFile || null;
    this.minIpIntervalMs = Number(options.minIpIntervalMs || DEFAULT_MIN_IP_INTERVAL_MS);
    this.cooldownMs = Number(options.cooldownMs || DEFAULT_COOLDOWN_MS);
    this.maxCooldownMs = Number(options.maxCooldownMs || DEFAULT_MAX_COOLDOWN_MS);
    const initial = {
      nextGroup: 'A',
      consecutiveFailures: 0,
      egresses: {},
      activeEgressIds: [],
      runtimeActiveEgressIds: [],
      selectionBusinessDate: null,
      lastBenchmarkAttemptAt: null,
      benchmark: null
    };
    this.state = readJson(this.statePath, initial);
    if (!this.state.egresses || typeof this.state.egresses !== 'object') this.state = initial;
    const configuredIds = new Set(this.egresses.map(egress => egress.id));
    for (const id of Object.keys(this.state.egresses)) {
      if (!configuredIds.has(id)) delete this.state.egresses[id];
    }
    if (!this.state.nextGroup) this.state.nextGroup = 'A';
    if (!Array.isArray(this.state.activeEgressIds)) this.state.activeEgressIds = [];
    this.state.activeEgressIds = this.state.activeEgressIds.filter(id => configuredIds.has(id));
    if (!Array.isArray(this.state.runtimeActiveEgressIds)) {
      this.state.runtimeActiveEgressIds = this.dailyBenchmark
        ? this.state.activeEgressIds.slice()
        : this.egresses.map(egress => egress.id);
    }
    this.state.runtimeActiveEgressIds = this.state.runtimeActiveEgressIds.filter(id => configuredIds.has(id));
    for (const egress of this.egresses) {
      if (!this.state.egresses[egress.id]) this.state.egresses[egress.id] = {
        id: egress.id,
        group: egress.group,
        last_attempt_at: null,
        next_eligible_at: 0,
        last_success_at: null,
        cooldown_until: 0,
        cooldown_reason: null,
        probe_required: false,
        probe_in_flight: false,
        consecutive_failures: 0,
        last_version: null,
        last_benchmark_duration_ms: null,
        last_benchmark_success: false,
        last_probe_at: null,
        last_probe_success: null
      };
    }
    if (!this.dailyBenchmark && this.state.runtimeActiveEgressIds.length === 0) {
      this.state.runtimeActiveEgressIds = this.egresses.map(egress => egress.id);
    }
    this.persist();
  }

  persist() {
    if (this.statePath) atomicWriteJson(this.statePath, this.state);
  }

  stateFor(egress) {
    return this.state.egresses[egress.id];
  }

  runtimePoolIds() {
    const configured = new Set(this.egresses.map(egress => egress.id));
    const ids = this.dailyBenchmark ? this.state.runtimeActiveEgressIds : this.egresses.map(egress => egress.id);
    return new Set((Array.isArray(ids) ? ids : []).filter(id => configured.has(id)));
  }

  needsDailyBenchmark(businessDate, now = Date.now()) {
    if (!this.dailyBenchmark) return false;
    if (this.state.selectionBusinessDate === businessDate && this.runtimePoolIds().size > 0) return false;
    const lastAttempt = Date.parse(this.state.lastBenchmarkAttemptAt || '');
    return !Number.isFinite(lastAttempt) || now - lastAttempt >= this.benchmarkRetryMs;
  }

  prepareDailyBenchmark(businessDate, at = Date.now()) {
    if (!this.dailyBenchmark) return;
    if (this.state.selectionBusinessDate !== businessDate) {
      this.state.selectionBusinessDate = null;
      this.state.activeEgressIds = [];
      this.state.runtimeActiveEgressIds = [];
      this.state.lastBenchmarkAttemptAt = null;
      this.state.benchmark = null;
    }
    this.state.benchmarkStartedAt = new Date(at).toISOString();
    this.persist();
  }

  recordBenchmarkAttempt(at = Date.now(), results = []) {
    this.state.lastBenchmarkAttemptAt = new Date(at).toISOString();
    this.state.benchmark = {
      completedAt: new Date(at).toISOString(),
      results: Array.isArray(results) ? results : []
    };
    for (const result of results) {
      const egress = this.egresses.find(candidate => candidate.id === result.id);
      if (!egress) continue;
      const state = this.stateFor(egress);
      state.last_benchmark_duration_ms = result.durationMs ?? null;
      state.last_benchmark_success = Boolean(result.success);
    }
    this.persist();
  }

  setDailySelection(businessDate, selectedIds, at = Date.now(), results = []) {
    const configured = new Set(this.egresses.map(egress => egress.id));
    const ids = Array.from(new Set((selectedIds || []).filter(id => configured.has(id)))).slice(0, this.activeCount);
    this.state.selectionBusinessDate = businessDate;
    this.state.activeEgressIds = ids;
    this.state.runtimeActiveEgressIds = ids.slice();
    this.recordBenchmarkAttempt(at, results);
    this.persist();
    return ids;
  }

  rotateAfterFailure(egress, now = Date.now()) {
    if (!this.dailyBenchmark) return null;
    const current = this.runtimePoolIds();
    if (!current.has(egress.id)) return null;
    const excluded = new Set(current);
    const available = candidate => {
      const state = this.stateFor(candidate);
      return !excluded.has(candidate.id)
        && state
        && !state.probe_required
        && now >= Number(state.cooldown_until || 0);
    };
    const candidates = this.egresses.filter(available);
    candidates.sort((a, b) => {
      const sameGroup = Number(b.group === egress.group) - Number(a.group === egress.group);
      if (sameGroup) return sameGroup;
      const ad = Number(this.stateFor(a).last_benchmark_duration_ms ?? Number.MAX_SAFE_INTEGER);
      const bd = Number(this.stateFor(b).last_benchmark_duration_ms ?? Number.MAX_SAFE_INTEGER);
      return ad - bd || a.id.localeCompare(b.id);
    });
    const replacement = candidates[0] || null;
    const next = Array.from(current).filter(id => id !== egress.id);
    if (replacement) next.push(replacement.id);
    this.state.runtimeActiveEgressIds = next;
    this.persist();
    return replacement;
  }

  choose(group, now = Date.now(), excluded = new Set()) {
    const pool = this.runtimePoolIds();
    const candidates = this.egresses.filter(egress => {
      const state = this.stateFor(egress);
      return egress.group === group && pool.has(egress.id) && !excluded.has(egress.id) && state && now >= Number(state.next_eligible_at || 0) && now >= Number(state.cooldown_until || 0);
    });
    candidates.sort((a, b) => {
      const sa = this.stateFor(a);
      const sb = this.stateFor(b);
      return Number(sa.last_attempt_at || 0) - Number(sb.last_attempt_at || 0)
        || Number(sa.last_benchmark_duration_ms ?? Number.MAX_SAFE_INTEGER) - Number(sb.last_benchmark_duration_ms ?? Number.MAX_SAFE_INTEGER)
        || a.id.localeCompare(b.id);
    });
    return candidates[0] || null;
  }

  chooseProbe(now = Date.now(), excluded = new Set()) {
    const candidates = this.egresses.filter(egress => {
      const state = this.stateFor(egress);
      return state
        && state.probe_required
        && !excluded.has(egress.id)
        && now >= Number(state.next_eligible_at || 0)
        && now >= Number(state.cooldown_until || 0);
    });
    candidates.sort((a, b) => {
      const sa = this.stateFor(a);
      const sb = this.stateFor(b);
      return Number(sa.last_attempt_at || 0) - Number(sb.last_attempt_at || 0)
        || Number(sa.last_benchmark_duration_ms ?? Number.MAX_SAFE_INTEGER) - Number(sb.last_benchmark_duration_ms ?? Number.MAX_SAFE_INTEGER)
        || a.id.localeCompare(b.id);
    });
    return candidates[0] || null;
  }

  restoreAfterProbe(egress) {
    if (!this.dailyBenchmark) return;
    const selected = new Set(this.state.activeEgressIds || []);
    if (!selected.has(egress.id)) return;
    const current = this.runtimePoolIds();
    if (current.has(egress.id)) return;
    const next = Array.from(current);
    const temporary = next
      .filter(id => !selected.has(id))
      .map(id => this.egresses.find(candidate => candidate.id === id))
      .filter(Boolean)
      .sort((a, b) => Number(a.group !== egress.group) - Number(b.group !== egress.group) || a.id.localeCompare(b.id));
    if (next.length >= this.activeCount && temporary.length > 0) {
      next.splice(next.indexOf(temporary[0].id), 1);
    }
    if (next.length < this.activeCount) next.push(egress.id);
    this.state.runtimeActiveEgressIds = Array.from(new Set(next));
    this.persist();
  }

  chooseNext(now = Date.now(), excluded = new Set()) {
    const first = this.state.nextGroup === 'A' ? 'A' : 'B';
    const second = first === 'A' ? 'B' : 'A';
    return this.choose(first, now, excluded) || this.choose(second, now, excluded);
  }

  markAttempt(egress, now = Date.now()) {
    const state = this.stateFor(egress);
    state.probe_in_flight = Boolean(state.probe_required);
    state.last_attempt_at = now;
    state.next_eligible_at = now + this.minIpIntervalMs;
    this.persist();
  }

  markResult(egress, result, now = Date.now(), error = null, context = {}) {
    const state = this.stateFor(egress);
    const failureCategory = classifyFailure(result, error);
    const wasProbe = Boolean(state.probe_in_flight || state.probe_required);
    if (!failureCategory && result?.statusCode >= 200 && result.statusCode < 300) {
      state.last_success_at = now;
      state.cooldown_until = 0;
      state.cooldown_reason = null;
      state.probe_required = false;
      state.probe_in_flight = false;
      state.consecutive_failures = 0;
      state.last_version = result.versionToken || result.payloadHash || null;
      if (wasProbe) {
        state.last_probe_at = new Date(now).toISOString();
        state.last_probe_success = true;
        this.restoreAfterProbe(egress);
      }
      this.state.consecutiveFailures = 0;
    } else {
      state.consecutive_failures = Number(state.consecutive_failures || 0) + 1;
      this.state.consecutiveFailures = Number(this.state.consecutiveFailures || 0) + 1;
      if (failureCategory === 'risk_control' || failureCategory === 'policy_rejected' || failureCategory === 'timeout' || state.probe_in_flight) {
        const cooldown = Math.min(this.maxCooldownMs, this.cooldownMs * (2 ** Math.max(0, state.consecutive_failures - 1)));
        state.cooldown_until = now + cooldown;
        state.cooldown_reason = failureCategory || 'health_probe_failed';
        state.probe_required = true;
      }
      if (wasProbe) {
        state.last_probe_at = new Date(now).toISOString();
        state.last_probe_success = false;
      }
      state.probe_in_flight = false;
      if (!context.benchmark) this.rotateAfterFailure(egress, now);
    }
    this.state.nextGroup = egress.group === 'A' ? 'B' : 'A';
    this.persist();
    return failureCategory;
  }

  nextEligibleAt(now = Date.now()) {
    const pool = this.runtimePoolIds();
    if (pool.size === 0) return now + this.benchmarkRetryMs;
    return Math.min(...this.egresses.filter(egress => pool.has(egress.id)).map(egress => {
      const state = this.stateFor(egress);
      return Math.max(Number(state.next_eligible_at || 0), Number(state.cooldown_until || 0), now);
    }));
  }

  health(now = Date.now()) {
    let availableA = 0;
    let availableB = 0;
    let cooling = 0;
    const pool = this.runtimePoolIds();
    for (const egress of this.egresses) {
      const state = this.stateFor(egress);
      if (Number(state.cooldown_until || 0) > now) cooling += 1;
      else if (pool.has(egress.id) && !state.probe_required && Number(state.next_eligible_at || 0) <= now) {
        if (egress.group === 'A') availableA += 1;
        else availableB += 1;
      }
    }
    return {
      availableEgressGroups: { A: availableA, B: availableB },
      coolingEgressCount: cooling,
      healthProbeEgressCount: this.egresses.filter(egress => this.stateFor(egress).probe_required).length,
      consecutiveFailures: Number(this.state.consecutiveFailures || 0),
      nextEligibleAt: this.nextEligibleAt(now),
      dailyBenchmark: this.dailyBenchmark,
      candidateEgressCount: this.egresses.length,
      activeEgressIds: this.state.activeEgressIds || [],
      runtimeActiveEgressIds: Array.from(pool),
      selectionBusinessDate: this.state.selectionBusinessDate || null,
      lastBenchmarkAttemptAt: this.state.lastBenchmarkAttemptAt || null
    };
  }
}

module.exports = {
  DEFAULT_EGRESSES,
  DEFAULT_MIN_IP_INTERVAL_MS,
  DEFAULT_ACTIVE_PER_GROUP,
  DEFAULT_ACTIVE_COUNT,
  DEFAULT_BENCHMARK_RETRY_MS,
  normalizeEgresses,
  normalizeEgressPlan,
  loadEgresses,
  loadEgressPlan,
  classifyFailure,
  EgressScheduler,
  atomicWriteJson
};
