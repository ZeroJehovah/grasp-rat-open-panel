'use strict';

const assert = require('assert');
const { ResponseCache, TtlMemo, ifNoneMatchSatisfied, negotiateEncoding } = require('../api/cache');

function entry(text) {
  return { body: Buffer.from(text, 'utf8'), etag: `"${text}"` };
}

(async () => {
  // Cloudflare 把强 ETag 改写成弱形式后浏览器原样回传，修复前这种请求永远拿不到 304。
  assert.strictEqual(ifNoneMatchSatisfied('W/"abc"', '"abc"'), true);
  assert.strictEqual(ifNoneMatchSatisfied('"abc"', '"abc"'), true);
  assert.strictEqual(ifNoneMatchSatisfied('W/"abc"', 'W/"abc"'), true);
  assert.strictEqual(ifNoneMatchSatisfied('*', '"abc"'), true);
  assert.strictEqual(ifNoneMatchSatisfied('W/"zzz", "abc"', '"abc"'), true);
  assert.strictEqual(ifNoneMatchSatisfied('  W/"abc"  ', '"abc"'), true);
  assert.strictEqual(ifNoneMatchSatisfied('"abc"', '"abd"'), false);
  assert.strictEqual(ifNoneMatchSatisfied('', '"abc"'), false);
  assert.strictEqual(ifNoneMatchSatisfied(undefined, '"abc"'), false);
  assert.strictEqual(ifNoneMatchSatisfied('W/"abc"', null), false);
  // 引号里带逗号的 ETag 不能被按逗号切碎。
  assert.strictEqual(ifNoneMatchSatisfied('W/"a,b"', '"a,b"'), true);
  assert.strictEqual(ifNoneMatchSatisfied('not-an-etag', '"abc"'), false);

  // 自己协商编码是为了在命中缓存时直接送出缓存好的压缩结果。判断不了就返回 null，
  // 退回 @fastify/compress 每次现压——失败方向是"慢一点"，不是"错"。
  const encodings = ['br', 'gzip'];
  assert.strictEqual(negotiateEncoding('br, gzip', encodings), 'br');
  assert.strictEqual(negotiateEncoding('gzip, deflate, br', encodings), 'br');
  assert.strictEqual(negotiateEncoding('gzip, deflate', encodings), 'gzip');
  assert.strictEqual(negotiateEncoding('GZIP', encodings), 'gzip');
  assert.strictEqual(negotiateEncoding('x-gzip', encodings), 'gzip', 'x-gzip is the historical alias for gzip');
  assert.strictEqual(negotiateEncoding('*', encodings), 'br');
  assert.strictEqual(negotiateEncoding('deflate', encodings), null);
  assert.strictEqual(negotiateEncoding('identity', encodings), null);
  assert.strictEqual(negotiateEncoding('', encodings), null);
  assert.strictEqual(negotiateEncoding(undefined, encodings), null);
  assert.strictEqual(negotiateEncoding('br, gzip', []), null);
  // q 值必须生效，q=0 是明确的拒绝。
  assert.strictEqual(negotiateEncoding('br;q=0.1, gzip;q=0.9', encodings), 'gzip');
  assert.strictEqual(negotiateEncoding('br;q=0, gzip', encodings), 'gzip');
  assert.strictEqual(negotiateEncoding('br;q=0, gzip;q=0', encodings), null);
  assert.strictEqual(negotiateEncoding('*;q=0, br', encodings), 'br');
  assert.strictEqual(negotiateEncoding('br;q=0, *', encodings), 'gzip');
  assert.strictEqual(negotiateEncoding('gzip; q = 0.5 , br; q=0.4', encodings), 'gzip');
  assert.strictEqual(negotiateEncoding('br;q=bogus', encodings), null);

  let clock = 1_000;
  const cache = new ResponseCache({ maxEntries: 3, maxBytes: 1_000, now: () => clock });
  let builds = 0;
  const build = text => async () => { builds += 1; return entry(text); };

  const first = await cache.load('k1', 60_000, build('one'));
  assert.strictEqual(first.state, 'miss');
  assert.strictEqual(builds, 1);
  const second = await cache.load('k1', 60_000, build('one'));
  assert.strictEqual(second.state, 'hit');
  assert.strictEqual(builds, 1, 'a cache hit must not rebuild');
  assert.strictEqual(second.entry.body.toString('utf8'), 'one');

  // TTL 过期后必须重建，并且旧条目的字节数要从统计里扣掉。
  clock += 60_001;
  const expired = await cache.load('k1', 60_000, build('one-again'));
  assert.strictEqual(expired.state, 'miss');
  assert.strictEqual(builds, 2);
  assert.strictEqual(cache.stats().expired, 1);
  assert.strictEqual(cache.stats().entries, 1);
  assert.strictEqual(cache.stats().bytes, Buffer.byteLength('one-again'));

  // key 为 null 表示不可共享的响应：照样构建，但不写缓存也不计入命中统计。
  const bypassHits = cache.stats().hits;
  const bypass = await cache.load(null, 60_000, build('bypass'));
  assert.strictEqual(bypass.state, 'miss');
  assert.strictEqual(cache.stats().hits, bypassHits);
  assert.strictEqual(cache.stats().entries, 1);

  // 条数上限触发 LRU 淘汰，被淘汰的是最久没读过的键。
  await cache.load('k2', 60_000, build('two'));
  await cache.load('k3', 60_000, build('three'));
  await cache.load('k1', 60_000, build('one-again'));  // 读一次 k1，把它移到队尾
  await cache.load('k4', 60_000, build('four'));
  assert.strictEqual(cache.stats().entries, 3);
  assert.strictEqual(cache.entries.has('k2'), false, 'least recently used entry should be evicted');
  assert.strictEqual(cache.entries.has('k1'), true);

  // 字节上限同样触发淘汰，而且单条超过总预算时直接不缓存，不能为了它把缓存清空。
  const tight = new ResponseCache({ maxEntries: 100, maxBytes: 20, now: () => clock });
  await tight.load('a', 60_000, async () => entry('x'.repeat(12)));
  await tight.load('b', 60_000, async () => entry('y'.repeat(12)));
  assert.strictEqual(tight.stats().entries, 1);
  assert.ok(tight.stats().bytes <= 20);
  await tight.load('huge', 60_000, async () => entry('z'.repeat(64)));
  assert.strictEqual(tight.entries.has('huge'), false, 'an entry larger than the budget must not be cached');
  assert.strictEqual(tight.entries.has('b'), true, 'caching an oversized entry must not flush the cache');

  // 冷缓存并发：同一个键只构建一次，后到的请求等前一个的结果。
  const herd = new ResponseCache({ now: () => clock });
  let herdBuilds = 0;
  const slowBuild = async () => {
    herdBuilds += 1;
    await new Promise(resolve => setImmediate(resolve));
    return entry('shared');
  };
  const results = await Promise.all([
    herd.load('same', 60_000, slowBuild),
    herd.load('same', 60_000, slowBuild),
    herd.load('same', 60_000, slowBuild)
  ]);
  assert.strictEqual(herdBuilds, 1, 'concurrent misses on one key must collapse into a single build');
  assert.deepStrictEqual(results.map(result => result.state).sort(), ['coalesced', 'coalesced', 'miss']);
  for (const result of results) assert.strictEqual(result.entry.body.toString('utf8'), 'shared');

  // 构建失败必须把 in-flight 记录清掉，否则这个键会被一个错误永久钉住。
  const failing = new ResponseCache({ now: () => clock });
  await assert.rejects(failing.load('boom', 60_000, async () => { throw new Error('build failed'); }), /build failed/);
  assert.strictEqual(failing.inFlight.size, 0);
  const recovered = await failing.load('boom', 60_000, build('recovered'));
  assert.strictEqual(recovered.entry.body.toString('utf8'), 'recovered');

  // ttlMs 为 0 表示禁用：构建照做，缓存不写。
  const disabled = new ResponseCache({ now: () => clock });
  await disabled.load('k', 0, build('x'));
  await disabled.load('k', 0, build('x'));
  assert.strictEqual(disabled.stats().entries, 0);

  // 压缩结果挂在缓存条目上，字节要补记进权重，否则一个装满压缩结果的缓存会悄悄超预算。
  const encoded = new ResponseCache({ maxEntries: 10, maxBytes: 1_000, now: () => clock });
  const held = (await encoded.load('body', 60_000, async () => entry('payload'))).entry;
  const baseBytes = encoded.stats().bytes;
  encoded.noteEncoded(held, 'br', Buffer.alloc(30));
  assert.strictEqual(encoded.encodedFor(held, 'br').length, 30);
  assert.strictEqual(encoded.stats().bytes, baseBytes + 30);
  assert.strictEqual(encoded.stats().compressions, 1);
  assert.strictEqual(encoded.stats().encodedBytes, 30);
  // 同一个条目可以同时挂 br 和 gzip 两份。
  encoded.noteEncoded(held, 'gzip', Buffer.alloc(40));
  assert.strictEqual(encoded.stats().bytes, baseBytes + 70);
  assert.strictEqual(encoded.encodedFor(held, 'gzip').length, 40);
  // 再取一次拿到的是同一个条目，压缩结果还在——命中缓存不重新压缩靠这个。
  const rehit = await encoded.load('body', 60_000, async () => entry('payload'));
  assert.strictEqual(rehit.state, 'hit');
  assert.strictEqual(encoded.encodedFor(rehit.entry, 'br').length, 30);
  assert.strictEqual(encoded.encodedFor(rehit.entry, 'deflate'), null);
  assert.strictEqual(encoded.encodedFor(null, 'br'), null);
  // 权重补记以后条目被淘汰时也要把这些字节一起扣掉。
  encoded.noteEncoded(held, 'br', Buffer.alloc(1_100));
  assert.strictEqual(encoded.stats().entries, 0, 'an entry that outgrows the budget is evicted');
  assert.strictEqual(encoded.stats().bytes, 0);
  // 没进缓存的旁路条目不参与计费，但压缩结果照样能挂上去用一次。
  const bypassEntry = (await encoded.load(null, 60_000, async () => entry('nocache'))).entry;
  encoded.noteEncoded(bypassEntry, 'br', Buffer.alloc(10));
  assert.strictEqual(encoded.stats().bytes, 0);
  assert.strictEqual(encoded.encodedFor(bypassEntry, 'br').length, 10);

  let memoClock = 0;
  const memo = new TtlMemo({ ttlMs: 1_000, now: () => memoClock });
  let loads = 0;
  const load = async () => { loads += 1; return { value: loads }; };
  assert.deepStrictEqual(await memo.resolve(load), { value: 1 });
  assert.deepStrictEqual(await memo.resolve(load), { value: 1 });
  assert.strictEqual(loads, 1);
  memoClock += 1_001;
  assert.deepStrictEqual(await memo.resolve(load), { value: 2 });
  assert.strictEqual(loads, 2);

  const coalescedMemo = new TtlMemo({ ttlMs: 1_000, now: () => memoClock });
  let memoBuilds = 0;
  const slowMemo = async () => { memoBuilds += 1; await new Promise(resolve => setImmediate(resolve)); return { ok: true }; };
  await Promise.all([coalescedMemo.resolve(slowMemo), coalescedMemo.resolve(slowMemo)]);
  assert.strictEqual(memoBuilds, 1, 'concurrent memo resolves must share one load');

  // ttlMs 为 0 的记忆化每次都重新加载，这是 PANEL_CACHE_DISABLED 依赖的行为。
  const memoOff = new TtlMemo({ ttlMs: 0, now: () => memoClock });
  let offLoads = 0;
  await memoOff.resolve(async () => { offLoads += 1; return {}; });
  await memoOff.resolve(async () => { offLoads += 1; return {}; });
  assert.strictEqual(offLoads, 2);

  console.log('cache tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
