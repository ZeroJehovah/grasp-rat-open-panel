'use strict';

// 历史数据按业务日分片缓存，再在后端拼成前端要的区间响应。
//
// 为什么按天：前端的日期范围是任意的（今天/昨天/本周/上周/本月/上月/自定义），按区间
// 做键的话键空间是组合爆炸的，而且只要区间包含今天，整段就会随每个快照版本（约 32 秒）
// 全部重算。按天分片以后，已经结束的日子算一次就永久有效，跨月请求也只需要重算今天那一片。
//
// 哪些能按天、哪些不能：聊天和击杀是严格可加的，一天的行拼起来就是区间的行。玩家维度
// 不是——它的 top-50 候选是在整个区间上排的，各天的 top-50 并集既不等于区间的 top-50，
// 而且 state/online/drop 这些实时字段本来就和区间无关。所以玩家只把"每天每个用户的
// 配额和战绩"这层按天缓存（这一层是可加的，而且是全量用户不做截断），排名和实时字段
// 每次现查。

const { MemoryCache, mapWithConcurrency } = require('../lib/memory-cache');
const { MAX_HISTORY_DAYS, addDays } = require('../domain/snapshot');

// 分片里存的是 pg 返回的行对象，精确大小拿不到；这里按行数乘以估算的每行字节给内存
// 设上界，宁可高估。
const ROW_WEIGHT = Object.freeze({
  messages: 1_024,
  kills: 2_048,
  playerDaily: 256,
  playerDrop: 64
});
const DEFAULT_ROW_WEIGHT = 512;

const DEFAULT_MAX_WEIGHT = 48 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 512;
// 已结束的日子只可能被 finalize-day 或迟到的投影补写改变，半小时的上界够了。
const CLOSED_TTL_MS = 30 * 60_000;
const OPEN_TTL_MS = 120_000;
// 一个跨月请求是三十次小查询，不限并发会把连接池抽干，连实时接口一起拖慢。
const DAY_CONCURRENCY = 4;
const CANDIDATE_LIMIT = 50;

function enumerateDays(range) {
  const days = [];
  const last = String(range.to);
  let day = String(range.from);
  while (day && day <= last && days.length <= MAX_HISTORY_DAYS) {
    days.push(day);
    day = addDays(day, 1);
  }
  return days;
}

// ---------------------------------------------------------------------------
// 精确十进制求和
//
// PG 的 SUM(numeric) 是精确十进制运算，而 income 的小数位能到 15 位（真实数据里有
// 23.999999999999996 这样的值），跨天用 JS 浮点相加得到的和和数据库的和不是同一个
// 双精度数——响应字节会变，ETag 也会变。所以按标度放大成整数用 BigInt 相加，最后一次性
// 转成 Number：结果和 Number(PG 返回的和) 逐位相同。
// ---------------------------------------------------------------------------

const DECIMAL_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function parseDecimal(value) {
  if (value === null || value === undefined) return null;
  const match = DECIMAL_PATTERN.exec(String(value).trim());
  if (!match) return null;
  const whole = match[2] || '';
  const fraction = match[3] || '';
  if (!whole && !fraction) return null;
  let units = BigInt(`${whole}${fraction}` || '0');
  let scale = fraction.length - Number(match[4] || 0);
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { units: match[1] === '-' ? -units : units, scale };
}

function alignDecimals(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    scale,
    left: left.units * 10n ** BigInt(scale - left.scale),
    right: right.units * 10n ** BigInt(scale - right.scale)
  };
}

function addDecimal(left, right) {
  if (left === null || left === undefined) return right;
  if (right === null || right === undefined) return left;
  const aligned = alignDecimals(left, right);
  return { units: aligned.left + aligned.right, scale: aligned.scale };
}

function compareDecimal(left, right) {
  const aligned = alignDecimals(left, right);
  if (aligned.left < aligned.right) return -1;
  return aligned.left > aligned.right ? 1 : 0;
}

// PG 的 numeric 加法保留最大标度（1.50 + 2.1 输出 3.60），这里拼出的十进制串和它一致。
function decimalToNumber(value) {
  if (value === null || value === undefined) return null;
  if (value.scale === 0) return Number(value.units);
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0');
  const boundary = digits.length - value.scale;
  return Number(`${negative ? '-' : ''}${digits.slice(0, boundary)}.${digits.slice(boundary)}`);
}

// ---------------------------------------------------------------------------
// 事件类分片的拼接
// ---------------------------------------------------------------------------

function eventTime(row) {
  const value = row.event_at;
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined) return Number.POSITIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

// 每天的行在库里已经按 (event_at, 主键) 排好。按日期升序拼起来后只按 event_at 做一次
// 稳定排序，就等于原来的 ORDER BY event_at, <日期列>, <主键>：稳定性保证 event_at 相同
// 时仍然先按天、再按库里的主键顺序。这样不必假设两天的 event_at 区间不重叠。
function composeEventRows(fragments) {
  const rows = [];
  for (const fragment of fragments) {
    for (const row of fragment) rows.push(row);
  }
  return rows.sort((left, right) => {
    const delta = eventTime(left) - eventTime(right);
    return Number.isNaN(delta) ? 0 : delta;
  });
}

// ---------------------------------------------------------------------------
// 玩家维度的拼接
// ---------------------------------------------------------------------------

// 输入是按日期升序的每日分片，每行来自 player_daily_stats 和 player_daily_quota 的
// 全外连接。输出等价于原来的 ranged_stats + ranged_quota 两个 CTE。
function composePlayerAggregates(fragments) {
  const aggregates = new Map();
  for (const fragment of fragments) {
    for (const row of fragment) {
      const userId = Number(row.user_id);
      let aggregate = aggregates.get(userId);
      if (!aggregate) {
        aggregate = { userId, kills: null, deaths: null, hasQuota: false, initialQuota: null, quotaValue: null, income: null, incomeComplete: true };
        aggregates.set(userId, aggregate);
      }
      // kills/deaths 在库里是 NOT NULL，为空只可能是这天没有统计行；整个区间都没有时
      // 保持 null，和原来的 LEFT JOIN 一致。
      if (row.kills !== null && row.kills !== undefined) {
        aggregate.kills = (aggregate.kills || 0) + Number(row.kills);
        aggregate.deaths = (aggregate.deaths || 0) + Number(row.deaths || 0);
      }
      if (!row.has_quota) continue;
      aggregate.hasQuota = true;
      // initial 取区间内第一个非空、value 取最后一个非空，对应原来的
      // array_agg(... ORDER BY local_date)[1] 和 array_agg(... ORDER BY local_date DESC)[1]。
      if (aggregate.initialQuota === null && row.initial_quota !== null && row.initial_quota !== undefined) aggregate.initialQuota = row.initial_quota;
      if (row.closing_quota !== null && row.closing_quota !== undefined) aggregate.quotaValue = row.closing_quota;
      // 原来是 CASE WHEN bool_and(income IS NOT NULL) THEN SUM(income) END：区间内只要
      // 有一天缺 income，整个区间的 income 就是 null。
      if (row.income === null || row.income === undefined) aggregate.incomeComplete = false;
      else aggregate.income = addDecimal(aggregate.income, parseDecimal(row.income));
    }
  }
  return aggregates;
}

function rangeIncome(aggregate) {
  return aggregate.hasQuota && aggregate.incomeComplete ? aggregate.income : null;
}

function topUserIds(aggregates, valueOf, limit) {
  const ranked = [];
  for (const aggregate of aggregates) {
    const value = valueOf(aggregate);
    if (value === null || value === undefined) continue;
    ranked.push({ userId: aggregate.userId, value });
  }
  ranked.sort((left, right) => compareDecimal(right.value, left.value) || left.userId - right.userId);
  return ranked.slice(0, limit).map(item => item.userId);
}

// 和原来的 quota_top ∪ drop_top ∪ income_top 一致：三条各取 50 名再求并集。排名用精确
// 十进制比较，避免两个只差在第 17 位的值在 JS 里并成同一个数而改变入选名单。
function selectPlayerCandidates(aggregates, dropTopIds, limit = CANDIDATE_LIMIT) {
  const list = Array.from(aggregates.values());
  const ids = new Set();
  for (const userId of topUserIds(list, item => parseDecimal(item.quotaValue), limit)) ids.add(userId);
  for (const userId of topUserIds(list, item => rangeIncome(item), limit)) ids.add(userId);
  for (const userId of dropTopIds) ids.add(Number(userId));
  return Array.from(ids).sort((left, right) => left - right);
}

// ---------------------------------------------------------------------------

class HistoryDayCache extends MemoryCache {
  constructor(options = {}) {
    super({
      maxWeight: Number.isFinite(Number(options.maxWeight)) ? Number(options.maxWeight) : DEFAULT_MAX_WEIGHT,
      maxEntries: Number.isFinite(Number(options.maxEntries)) ? Number(options.maxEntries) : DEFAULT_MAX_ENTRIES,
      now: options.now
    });
    this.disabled = Boolean(options.disabled);
    this.closedTtlMs = Number.isFinite(Number(options.closedTtlMs)) ? Number(options.closedTtlMs) : CLOSED_TTL_MS;
    this.openTtlMs = Number.isFinite(Number(options.openTtlMs)) ? Number(options.openTtlMs) : OPEN_TTL_MS;
    this.concurrency = Number.isFinite(Number(options.concurrency)) ? Number(options.concurrency) : DAY_CONCURRENCY;
  }

  weigh(entry) {
    return Math.max(1, entry.rows.length * (ROW_WEIGHT[entry.kind] || DEFAULT_ROW_WEIGHT));
  }

  // 还没结束的日子（最新快照那天，以及理论上比它更晚的日子）内容还会变，键里带版本
  // 令牌，令牌一变旧分片自然失效；已经结束的日子键里只有日期。
  isOpenDay(day, context) {
    return !context.latestDay || String(day) >= String(context.latestDay);
  }

  keyFor(kind, day, context) {
    if (this.disabled) return null;
    return this.isOpenDay(day, context) ? `${kind}:${day}:${context.token || 'none'}` : `${kind}:${day}`;
  }

  ttlFor(day, context) {
    return this.isOpenDay(day, context) ? this.openTtlMs : this.closedTtlMs;
  }

  async loadDay(kind, day, context, build) {
    const { entry } = await this.load(this.keyFor(kind, day, context), this.ttlFor(day, context), async () => ({ kind, rows: await build(day) }));
    return entry.rows;
  }

  async loadDays(kind, days, context, build) {
    return mapWithConcurrency(days, this.concurrency, day => this.loadDay(kind, day, context, build));
  }
}

module.exports = {
  HistoryDayCache,
  CANDIDATE_LIMIT,
  ROW_WEIGHT,
  enumerateDays,
  parseDecimal,
  addDecimal,
  compareDecimal,
  decimalToNumber,
  composeEventRows,
  composePlayerAggregates,
  selectPlayerCandidates,
  rangeIncome
};
