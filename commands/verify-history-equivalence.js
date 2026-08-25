#!/usr/bin/env node
'use strict';

// 按天分片拼出来的历史响应必须和原来的整区间查询逐字节一致：响应体的字节就是 ETag 的
// 输入，一点差异都会让所有客户端缓存静默失效，而玩家维度的 top-50 名单差一个人是看不
// 出来的。这个命令需要数据库，所以不在 npm test 里——改过历史查询或分片拼接之后手动跑。
//
//   node commands/verify-history-equivalence.js
//   node commands/verify-history-equivalence.js --from 2026-08-23 --to 2026-08-25
//
// 含今天的区间会随快照版本变化，所以每个区间都在版本没变的前提下比较，版本在中途变了
// 就重试。

const { PostgresPanelStore } = require('../storage/postgres-store');
const { addDays } = require('../domain/snapshot');

const RESOURCES = ['chat', 'players', 'kills'];
const WINDOWS = [3, 7, 14, 30];
const MAX_ATTEMPTS = 3;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const match = /^--([a-z-]+)$/.exec(argv[index]);
    if (match) args[match[1]] = argv[index + 1];
  }
  return args;
}

function rangeKey(range) {
  return `${range.from}..${range.to}`;
}

// 单日、相邻两天，再加上几个以最后一天结尾的窗口。全组合在 62 天上限下有近两千个区间，
// 这个取样已经覆盖了"闭合单日 / 闭合多日 / 含今天 / 跨月"这几类边界。
function candidateRanges(days) {
  const ranges = new Map();
  const add = range => {
    if (range.from && range.to && range.from <= range.to) ranges.set(rangeKey(range), range);
  };
  for (const day of days) add({ from: day, to: day });
  for (let index = 0; index + 1 < days.length; index += 1) add({ from: days[index], to: days[index + 1] });
  const last = days.at(-1);
  const first = days[0];
  for (const size of WINDOWS) {
    const from = addDays(last, -(size - 1));
    if (from && from >= first) add({ from, to: last });
  }
  add({ from: first, to: last });
  return Array.from(ranges.values());
}

function firstDifference(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      const start = Math.max(0, index - 60);
      return { index, composed: left.slice(start, index + 60), direct: right.slice(start, index + 60) };
    }
  }
  return { index: length, composed: left.slice(length, length + 120), direct: right.slice(length, length + 120) };
}

async function compareOnce(store, resource, range) {
  const before = await store.getLatestVersion();
  const composed = await store.getHistoryResource(resource, range);
  const direct = await store.getHistoryResourceDirect(resource, range);
  const cached = await store.getHistoryResource(resource, range);
  const after = await store.getLatestVersion();
  const token = value => value?.version_token || value?.snapshot_id || null;
  if (token(before) !== token(after)) return { retry: true };
  const composedJson = JSON.stringify(composed);
  const directJson = JSON.stringify(direct);
  const cachedJson = JSON.stringify(cached);
  if (cachedJson !== composedJson) return { ok: false, reason: 'cache', diff: firstDifference(cachedJson, composedJson), bytes: composedJson.length };
  if (composedJson !== directJson) return { ok: false, reason: 'compose', diff: firstDifference(composedJson, directJson), bytes: composedJson.length };
  return { ok: true, bytes: composedJson.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = new PostgresPanelStore({});
  let failures = 0;
  try {
    const meta = await store.getMeta();
    const days = Array.isArray(meta.availableDates) ? meta.availableDates : [];
    if (days.length === 0) {
      console.log('no available business days; nothing to verify');
      return;
    }
    const ranges = args.from && args.to ? [{ from: args.from, to: args.to }] : candidateRanges(days);
    console.log(`verifying ${ranges.length} range(s) x ${RESOURCES.length} resource(s) over ${days[0]}..${days.at(-1)}`);
    for (const range of ranges) {
      for (const resource of RESOURCES) {
        let result = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          result = await compareOnce(store, resource, range);
          if (!result.retry) break;
          console.log(`  ${resource} ${rangeKey(range)}: snapshot version changed mid-comparison, retrying (${attempt}/${MAX_ATTEMPTS})`);
        }
        if (result.retry) {
          console.log(`  SKIP ${resource} ${rangeKey(range)}: version kept changing`);
          continue;
        }
        if (result.ok) {
          console.log(`  ok   ${resource} ${rangeKey(range)} (${result.bytes} bytes)`);
          continue;
        }
        failures += 1;
        console.error(`  FAIL ${resource} ${rangeKey(range)} (${result.reason}) at byte ${result.diff.index}`);
        console.error(`    composed: ${result.diff.composed}`);
        console.error(`    direct  : ${result.diff.direct}`);
      }
    }
    console.log(failures === 0 ? 'all ranges byte-identical' : `${failures} mismatch(es)`);
  } finally {
    await store.close();
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
