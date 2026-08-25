'use strict';

const assert = require('assert');
const {
  HistoryDayCache,
  enumerateDays,
  parseDecimal,
  addDecimal,
  compareDecimal,
  decimalToNumber,
  composeEventRows,
  composePlayerAggregates,
  selectPlayerCandidates,
  rangeIncome
} = require('../storage/history-cache');

function sumExact(values) {
  return decimalToNumber(values.reduce((total, value) => addDecimal(total, parseDecimal(value)), null));
}

(async () => {
  assert.deepStrictEqual(enumerateDays({ from: '2026-08-20', to: '2026-08-22' }), ['2026-08-20', '2026-08-21', '2026-08-22']);
  assert.deepStrictEqual(enumerateDays({ from: '2026-08-22', to: '2026-08-22' }), ['2026-08-22']);
  assert.deepStrictEqual(enumerateDays({ from: '2026-08-23', to: '2026-08-22' }), []);
  assert.deepStrictEqual(enumerateDays({ from: '2026-02-27', to: '2026-03-01' }), ['2026-02-27', '2026-02-28', '2026-03-01']);
  assert.ok(enumerateDays({ from: '2020-01-01', to: '2026-08-22' }).length <= 63, 'day enumeration must stay bounded');

  // 精确十进制求和。income 在真实数据里的小数位能到 15 位，跨天用 JS 浮点相加得到的和
  // 和 PG 的 SUM(numeric) 不是同一个双精度数，响应字节和 ETag 都会跟着变。
  assert.strictEqual(sumExact(['0.1', '0.2']), 0.3);
  assert.notStrictEqual(0.1 + 0.2, 0.3, 'the float path this replaces really does diverge');
  assert.strictEqual(sumExact(['1.05', '2.10', '3.15']), 6.3);
  assert.strictEqual(sumExact(['47.00000000000001', '23.999999999999996']), Number('71.000000000000006'));
  assert.strictEqual(sumExact(['170', '809', '694']), 1673);
  assert.strictEqual(sumExact(['-49251', '3420', '4898']), -40933);
  assert.strictEqual(sumExact(['0', '0']), 0);
  // PG 的 numeric 加法保留最大标度（1.50 + 2.1 输出 3.60），转成 Number 后是同一个值。
  assert.strictEqual(sumExact(['1.50', '2.1']), 3.6);
  assert.strictEqual(sumExact(['1e2', '0.5']), 100.5);
  assert.strictEqual(parseDecimal(null), null);
  assert.strictEqual(parseDecimal(''), null);
  assert.strictEqual(parseDecimal('abc'), null);
  assert.strictEqual(decimalToNumber(null), null);
  assert.strictEqual(decimalToNumber(parseDecimal('-0.25')), -0.25);
  assert.strictEqual(compareDecimal(parseDecimal('2.50'), parseDecimal('2.5')), 0);
  assert.strictEqual(compareDecimal(parseDecimal('2.5'), parseDecimal('10')), -1);
  assert.strictEqual(compareDecimal(parseDecimal('10'), parseDecimal('2.5')), 1);
  // 只差在第 17 位的两个值在 JS 浮点里是同一个数，精确比较能分开它们——排名的稳定性靠这个。
  assert.strictEqual(compareDecimal(parseDecimal('1.00000000000000001'), parseDecimal('1')), 1);

  // 事件分片拼接：按天升序拼好后只按 event_at 稳定排序，等价于原来的
  // ORDER BY event_at, <日期列>, <主键>，而且不依赖"两天的 event_at 不重叠"这个假设。
  const dayOne = [
    { server_day: '2026-08-20', message_id: 'a', event_at: new Date('2026-08-20T10:00:00Z') },
    { server_day: '2026-08-20', message_id: 'b', event_at: new Date('2026-08-20T12:00:00Z') }
  ];
  const dayTwo = [
    { server_day: '2026-08-21', message_id: 'c', event_at: new Date('2026-08-20T11:00:00Z') },
    { server_day: '2026-08-21', message_id: 'd', event_at: new Date('2026-08-20T12:00:00Z') }
  ];
  assert.deepStrictEqual(composeEventRows([dayOne, dayTwo]).map(row => row.message_id), ['a', 'c', 'b', 'd']);
  assert.deepStrictEqual(composeEventRows([[], []]), []);
  // event_at 相同时先按天、再按库里的主键顺序，靠排序的稳定性保证。
  const tied = composeEventRows([
    [{ message_id: 'x1', event_at: new Date('2026-08-20T00:00:00Z') }, { message_id: 'x2', event_at: new Date('2026-08-20T00:00:00Z') }],
    [{ message_id: 'y1', event_at: new Date('2026-08-20T00:00:00Z') }]
  ]);
  assert.deepStrictEqual(tied.map(row => row.message_id), ['x1', 'x2', 'y1']);
  // 字符串时间戳也要能排（pg 的类型解析器可配置）。
  assert.deepStrictEqual(
    composeEventRows([[{ message_id: 's2', event_at: '2026-08-20T02:00:00Z' }], [{ message_id: 's1', event_at: '2026-08-20T01:00:00Z' }]]).map(row => row.message_id),
    ['s1', 's2']
  );

  // 玩家每日分片的聚合，等价于原来的 ranged_stats + ranged_quota 两个 CTE。
  const playerDays = [
    [
      { user_id: 1, kills: 2, deaths: 1, has_quota: true, initial_quota: null, closing_quota: '10.5', income: '0.1' },
      { user_id: 2, kills: 5, deaths: 0, has_quota: false, initial_quota: null, closing_quota: null, income: null },
      { user_id: 3, kills: null, deaths: null, has_quota: true, initial_quota: '7', closing_quota: null, income: null }
    ],
    [
      { user_id: 1, kills: 3, deaths: 4, has_quota: true, initial_quota: '9', closing_quota: null, income: '0.2' },
      { user_id: 3, kills: 1, deaths: 1, has_quota: true, initial_quota: '8', closing_quota: '3', income: '5' }
    ]
  ];
  const aggregates = composePlayerAggregates(playerDays);
  const first = aggregates.get(1);
  assert.strictEqual(first.kills, 5);
  assert.strictEqual(first.deaths, 5);
  assert.strictEqual(first.initialQuota, '9', 'initial must be the first non-null by ascending date');
  assert.strictEqual(first.quotaValue, '10.5', 'value must be the last non-null by ascending date');
  assert.strictEqual(decimalToNumber(rangeIncome(first)), 0.3);
  const second = aggregates.get(2);
  assert.strictEqual(second.hasQuota, false);
  assert.strictEqual(rangeIncome(second), null);
  assert.strictEqual(second.kills, 5);
  const third = aggregates.get(3);
  assert.strictEqual(third.kills, 1, 'a day without a stats row must not count as zero');
  assert.strictEqual(third.initialQuota, '7');
  assert.strictEqual(third.quotaValue, '3');
  // 区间内只要有一天缺 income，整个区间的 income 就是 null（原来的 bool_and 语义）。
  assert.strictEqual(rangeIncome(third), null);
  // 整个区间都没有战绩行时保持 null，映射时才落成 0，和原来的 LEFT JOIN 一致。
  const quotaOnly = composePlayerAggregates([[{ user_id: 9, kills: null, deaths: null, has_quota: true, initial_quota: '1', closing_quota: '2', income: '3' }]]).get(9);
  assert.strictEqual(quotaOnly.kills, null);
  assert.strictEqual(quotaOnly.deaths, null);
  assert.strictEqual(decimalToNumber(rangeIncome(quotaOnly)), 3);

  // 候选集是 quota 前 50 ∪ income 前 50 ∪ drop 前 50，最后按 user_id 升序。
  const ranking = composePlayerAggregates([[
    { user_id: 10, kills: 0, deaths: 0, has_quota: true, initial_quota: '0', closing_quota: '100', income: '1' },
    { user_id: 11, kills: 0, deaths: 0, has_quota: true, initial_quota: '0', closing_quota: '5', income: '900' },
    { user_id: 12, kills: 0, deaths: 0, has_quota: true, initial_quota: '0', closing_quota: '4', income: '2' },
    { user_id: 13, kills: 1, deaths: 1, has_quota: false, initial_quota: null, closing_quota: null, income: null }
  ]]);
  assert.deepStrictEqual(selectPlayerCandidates(ranking, [], 1), [10, 11], 'each ranking contributes its own top slice');
  assert.deepStrictEqual(selectPlayerCandidates(ranking, ['13'], 1), [10, 11, 13], 'drop ids join the candidate set');
  assert.deepStrictEqual(selectPlayerCandidates(ranking, [], 50), [10, 11, 12]);
  assert.deepStrictEqual(selectPlayerCandidates(new Map(), [], 50), []);
  // 排名并列时按 user_id 升序取，和 PG 的 ORDER BY value DESC, user_id 一致。
  const ties = composePlayerAggregates([[
    { user_id: 30, kills: 0, deaths: 0, has_quota: true, initial_quota: '0', closing_quota: '7', income: null },
    { user_id: 20, kills: 0, deaths: 0, has_quota: true, initial_quota: '0', closing_quota: '7.0', income: null }
  ]]);
  assert.deepStrictEqual(selectPlayerCandidates(ties, [], 1), [20]);

  // 分片缓存的键：已经结束的日子只按日期，最新那天按版本令牌。
  let clock = 1_000;
  const cache = new HistoryDayCache({ now: () => clock, closedTtlMs: 600_000, openTtlMs: 60_000, concurrency: 2 });
  const context = { latestDay: '2026-08-22', token: 'v1' };
  assert.strictEqual(cache.keyFor('kills', '2026-08-20', context), 'kills:2026-08-20');
  assert.strictEqual(cache.keyFor('kills', '2026-08-22', context), 'kills:2026-08-22:v1');
  assert.strictEqual(cache.ttlFor('2026-08-20', context), 600_000);
  assert.strictEqual(cache.ttlFor('2026-08-22', context), 60_000);
  // 没有版本信息时一切按"还在变"处理，宁可少缓存。
  assert.strictEqual(cache.keyFor('kills', '2026-08-20', { latestDay: null, token: null }), 'kills:2026-08-20:none');

  const queried = [];
  const fetch = async day => { queried.push(day); return [{ event_at: new Date(`${day}T00:00:00Z`), day }]; };
  const days = ['2026-08-20', '2026-08-21', '2026-08-22'];
  const firstPass = await cache.loadDays('kills', days, context, fetch);
  assert.deepStrictEqual(firstPass.map(rows => rows[0].day), days);
  assert.deepStrictEqual(queried.slice().sort(), days);

  // 版本令牌变了只需要重算最新那天，已结束的两天照旧命中。
  queried.length = 0;
  await cache.loadDays('kills', days, { latestDay: '2026-08-22', token: 'v2' }, fetch);
  assert.deepStrictEqual(queried, ['2026-08-22']);

  // 已结束日期的 TTL 到了要重算，而且旧条目的权重要从统计里扣掉。
  queried.length = 0;
  clock += 600_001;
  await cache.loadDays('kills', ['2026-08-20'], context, fetch);
  assert.deepStrictEqual(queried, ['2026-08-20']);
  assert.ok(cache.stats().expired >= 1);

  // 冷缓存并发：同一天只查一次。
  const shared = new HistoryDayCache({ now: () => clock });
  let sharedFetches = 0;
  const slowFetch = async () => {
    sharedFetches += 1;
    await new Promise(resolve => setImmediate(resolve));
    return [];
  };
  await Promise.all([
    shared.loadDay('messages', '2026-08-20', context, slowFetch),
    shared.loadDay('messages', '2026-08-20', context, slowFetch)
  ]);
  assert.strictEqual(sharedFetches, 1);

  // 权重按行数估算，超出预算时淘汰最久没用的分片。
  const tight = new HistoryDayCache({ now: () => clock, maxWeight: 4_096, maxEntries: 100 });
  await tight.loadDay('kills', '2026-08-01', context, async () => Array.from({ length: 1 }, () => ({})));
  await tight.loadDay('kills', '2026-08-02', context, async () => Array.from({ length: 1 }, () => ({})));
  await tight.loadDay('kills', '2026-08-03', context, async () => Array.from({ length: 1 }, () => ({})));
  assert.ok(tight.stats().weight <= 4_096);
  assert.ok(tight.stats().evictions >= 1);

  // 关掉缓存时照样查、照样拼，只是不留缓存。
  const off = new HistoryDayCache({ now: () => clock, disabled: true });
  let offFetches = 0;
  await off.loadDays('kills', ['2026-08-20'], context, async () => { offFetches += 1; return []; });
  await off.loadDays('kills', ['2026-08-20'], context, async () => { offFetches += 1; return []; });
  assert.strictEqual(offFetches, 2);
  assert.strictEqual(off.stats().entries, 0);

  console.log('history cache tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
