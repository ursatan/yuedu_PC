/**
 * `#321` 源级限频 `concurrentRate` —— 锁三件事：
 * 1. **解析语义**（对齐上游 `ConcurrentRateLimiter.kt` 的两处解析并集）：
 *    `"N/M"` ⇒ M 毫秒 N 次；纯整数 M ⇒ 1 次/M 毫秒；`"0"`/空/解析失败/≤0 ⇒ 不限（null）。
 * 2. **放行节奏**：窗口内超名额要**等**（不报错不丢弃），窗口滚动后恢复；
 *    名额计数是**原子**的（并发调用不超发）。
 * 3. **按源隔离**：不同 key 各自计数，互不影响。
 *
 * 全部走真实时钟的小间隔（120~260ms），不 mock Date —— 上游语义里「窗口滚动」
 * 本身就是时间行为，mock 时钟容易把「已过窗口」判成「窗口内」造假绿。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseConcurrentRate,
  acquireConcurrentSlot,
  resetConcurrentRate,
  concurrentRateState,
} from '../net/concurrent-rate';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('parse: "N/M" = M 毫秒 N 次', () => {
  assert.deepEqual(parseConcurrentRate('30/5000'), { accessLimit: 30, interval: 5000 });
  assert.deepEqual(parseConcurrentRate('18/30000'), { accessLimit: 18, interval: 30000 });
});

test('parse: 纯整数 M = 1 次/M 毫秒', () => {
  assert.deepEqual(parseConcurrentRate('1000'), { accessLimit: 1, interval: 1000 });
  assert.deepEqual(parseConcurrentRate('5'), { accessLimit: 1, interval: 5 });
});

test('parse: "0"/空/null/undefined/非数字/负数/除零 ⇒ 不限频', () => {
  assert.equal(parseConcurrentRate('0'), null);
  assert.equal(parseConcurrentRate(''), null);
  assert.equal(parseConcurrentRate('  '), null);
  assert.equal(parseConcurrentRate(null), null);
  assert.equal(parseConcurrentRate(undefined), null);
  assert.equal(parseConcurrentRate('abc'), null);
  assert.equal(parseConcurrentRate('-3'), null);
  assert.equal(parseConcurrentRate('-1/5000'), null);
  assert.equal(parseConcurrentRate('5/0'), null);
  assert.equal(parseConcurrentRate('0/5000'), null);
});

test('节奏: "2/400" 窗口内第 1、2 次立即过，第 3 次要等窗口滚动', async () => {
  resetConcurrentRate('k1');
  const t0 = Date.now();
  await acquireConcurrentSlot('k1', '2/400');
  await acquireConcurrentSlot('k1', '2/400');
  const twoFree = Date.now() - t0;
  // 前两次必须立刻放行。⚠️ 边距给 80ms：`pnpm -r test` 并行下调度抖动能到几十毫秒
  // （`#316` 同类教训——时间敏感断言边距太窄会假失败）；判别力靠与 400ms 窗口的间隔。
  assert.ok(twoFree < 80, `前两次应立即放行，实际耗时 ${twoFree}ms`);
  await acquireConcurrentSlot('k1', '2/400');
  const waited = Date.now() - t0;
  // 第三次必须真等过窗口：窗口从 t0 起算 400ms ⇒ 总耗时 ≥ 400ms
  assert.ok(waited >= 400, `第三次应等到窗口滚动，实际总耗时 ${waited}ms`);
});

test('节奏: 窗口滚动后恢复放行 + 计数重置', async () => {
  resetConcurrentRate('k2');
  await acquireConcurrentSlot('k2', '1/400'); // 占掉唯一名额
  const st0 = concurrentRateState('k2');
  assert.equal(st0?.frequency, 1);
  await sleep(450); // 过窗口
  const t0 = Date.now();
  await acquireConcurrentSlot('k2', '1/400'); // 必须立刻放行（新窗口）
  assert.ok(Date.now() - t0 < 80, '窗口滚动后应立即放行');
  assert.equal(concurrentRateState('k2')?.frequency, 1, '新窗口计数应重置为 1');
  void st0;
});

test('并发不超发: 4 个并发请求打 "2/400"，同窗口内放行的 ≤ 2 个', async () => {
  resetConcurrentRate('k3');
  const t0 = Date.now();
  await Promise.all([
    acquireConcurrentSlot('k3', '2/400'),
    acquireConcurrentSlot('k3', '2/400'),
    acquireConcurrentSlot('k3', '2/400'),
    acquireConcurrentSlot('k3', '2/400'),
  ]);
  const total = Date.now() - t0;
  const st = concurrentRateState('k3');
  // 4 个全过（等待制，不丢弃），但窗口计数只到 2（另两个在新窗口）
  assert.equal(st?.frequency, 2, '窗口内计数应恰好为 2（不超发）');
  // 且至少要等过一轮窗口（4 个里 2 个得等 400ms）
  assert.ok(total >= 400, `应有请求等到窗口滚动，实际总耗时 ${total}ms`);
});

test('按源隔离: 不同 key 各自计数', async () => {
  resetConcurrentRate('a1');
  resetConcurrentRate('a2');
  await acquireConcurrentSlot('a1', '1/10000');
  const t0 = Date.now();
  await acquireConcurrentSlot('a2', '1/10000'); // 另一源 ⇒ 不受 a1 名额影响，立即放行
  assert.ok(Date.now() - t0 < 80, '不同源的限频应互不影响');
});

test('不限频: rate 为空/"0"/null 时 acquire 直接返回（不建记录）', async () => {
  resetConcurrentRate('k5');
  await acquireConcurrentSlot('k5', '0');
  await acquireConcurrentSlot('k5', '');
  await acquireConcurrentSlot('k5', null);
  assert.equal(concurrentRateState('k5'), null, '不限频的源不应产生记录');
});

/* ===== `#331` updateConcurrentRate（上游 source.putConcurrent 的唯一落点）===== */

import { updateConcurrentRate } from '../net/concurrent-rate';

test('#331 updateConcurrentRate: "a/b" 与纯数字两种形态都生效', () => {
  resetConcurrentRate('s1');
  assert.equal(updateConcurrentRate('s1', '3/600'), true);
  assert.deepEqual(concurrentRateState('s1')?.spec, { accessLimit: 3, interval: 600 });
  assert.equal(updateConcurrentRate('s2', '800'), true);
  assert.deepEqual(concurrentRateState('s2')?.spec, { accessLimit: 1, interval: 800 });
  resetConcurrentRate('s1');
  resetConcurrentRate('s2');
});

test('#331 updateConcurrentRate: 解析失败 ⇒ 记录原样保留（上游 catch 语义）', () => {
  resetConcurrentRate('s3');
  assert.equal(updateConcurrentRate('s3', '2/400'), true);
  const before = concurrentRateState('s3');
  assert.equal(updateConcurrentRate('s3', 'not-a-rate'), false, '解析失败必须返 false');
  assert.deepEqual(concurrentRateState('s3'), before, '记录不得被改动/删除');
  assert.equal(updateConcurrentRate('s3', '0/400'), false, '≤0 视为解析失败');
  assert.equal(updateConcurrentRate('s3', ''), false);
  assert.equal(updateConcurrentRate('', '2/400'), false, '空 key 直接拒');
  assert.deepEqual(concurrentRateState('s3'), before);
  resetConcurrentRate('s3');
});

test('#331 updateConcurrentRate: 改规格但 time/frequency 继承（不重置窗口计数）', async () => {
  resetConcurrentRate('s4');
  assert.equal(updateConcurrentRate('s4', '5/600'), true);
  await acquireConcurrentSlot('s4', '5/600');
  const st1 = concurrentRateState('s4');
  assert.equal(st1?.frequency, 1, '本窗口已发 1 个');
  // 改成更紧的规格 —— frequency 必须保留（否则瞬间超发）
  assert.equal(updateConcurrentRate('s4', '1/600'), true);
  const st2 = concurrentRateState('s4');
  assert.deepEqual(st2?.spec, { accessLimit: 1, interval: 600 });
  assert.equal(st2?.frequency, st1?.frequency, 'frequency 必须继承');
  assert.equal(st2?.time, st1?.time, 'time（窗口起点）必须继承');
  resetConcurrentRate('s4');
});
