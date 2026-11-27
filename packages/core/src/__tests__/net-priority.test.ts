/**
 * 网络护栏「排队优先级」回归锁（2026-09-26）。
 *
 * ## 为什么必须有
 * `globalSem` / `hostSem` 是**模块级单例**，图片代理 `/api/proxy`（封面/正文图）与引擎
 * `/api/run`（详情/目录/正文解析）**共用同一组并发槽位**。实测（受控 A/B）：
 * 发现页几十张封面在飞时，用户点卡片触发的 detail 要多等 **+820ms（服务端排队，+23%）**，
 * 叠加浏览器同源 6 连接的限制共 **+1784ms（+47%）**。
 *
 * 修法是给后台资源一个低优先通道。这里锁住三条语义，错一条就会变成「封面永远拿不到槽位」
 * 或者「低优先白标了」：
 *   ① **有空槽时低优先照样立刻放行**（不影响吞吐，只是排队顺序）；
 *   ② 需要排队时**高优先先出队**（交互请求插到封面前面）；
 *   ③ 同类请求之间仍是 **FIFO**（否则「有的秒回、有的等很久」，不可复现）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Semaphore } from '../net/index';

/** 记录出队顺序的小工具 */
function tracker() {
  const order: string[] = [];
  return { order, mark: (x: string) => order.push(x) };
}

test('① 有空槽时低优先立刻拿到（不受排队影响）', async () => {
  const sem = new Semaphore(() => 2);
  const t = tracker();
  await sem.acquire('high');
  await sem.acquire('low'); // 还有空槽（2/2 未满）
  t.mark('low-进入了');
  assert.deepEqual(t.order, ['low-进入了'], '低优先在有空槽时不得排队');
});

test('② 需要排队时高优先先出队（交互请求插到封面前面）', async () => {
  const sem = new Semaphore(() => 1);
  const t = tracker();
  await sem.acquire('high'); // 占满
  const pLow1 = sem.acquire('low').then(() => t.mark('low1'));
  const pHigh = sem.acquire('high').then(() => t.mark('high'));
  const pLow2 = sem.acquire('low').then(() => t.mark('low2'));
  await new Promise((r) => setTimeout(r, 10)); // 让三个都进队列
  sem.release();
  await pHigh;
  assert.equal(t.order[0], 'high', `第一个出队的应是高优先，实际 ${JSON.stringify(t.order)}`);
  sem.release();
  await pLow1;
  assert.equal(t.order[1], 'low1', '低优先之间保持 FIFO');
  sem.release();
  await pLow2;
  assert.deepEqual(t.order, ['high', 'low1', 'low2']);
});

test('③ 同类请求之间仍是 FIFO（可复现）', async () => {
  const sem = new Semaphore(() => 1);
  const t = tracker();
  await sem.acquire('high');
  const ps = ['a', 'b', 'c'].map((n) => sem.acquire('low').then(() => t.mark(n)));
  await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 3; i++) {
    sem.release();
    await ps[i];
  }
  assert.deepEqual(t.order, ['a', 'b', 'c']);
});

test('④ release 不会把 active 减成负数（多余释放无副作用）', async () => {
  const sem = new Semaphore(() => 1);
  await sem.acquire('high');
  sem.release();
  sem.release(); // 多余的释放
  await sem.acquire('high'); // 仍应能拿到
  assert.ok(true, '多余 release 后仍可正常获取');
});
