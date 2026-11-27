/**
 * 回归锁（`#200`）：**流量护栏 v2** 的三层限额 + 熔断。
 *
 * 为什么这些断言必须存在：护栏是「出口 IP 不被封」的唯一保障，而它的失效方式是**静默的**
 * ——限流没生效不会报错，只会让站点在某天开始 403/封 IP。所以每条限额都要有钉死的测试。
 *
 * 参考设置（用户 2026-10-02 提供）：
 *   · 域名粒度（全局共享）：单域名总并发 ≤10 · 单域名单池 ≤8
 *   · 即时任务：每池 ≤6 · 任务总并发 ≤30 · RPS ≤5 · 超时 12s · 重试 2 · 失败冷却 200ms
 *   · 后台批量：每池 ≤8 · 任务总并发 ≤45 · RPS ≤8 · 超时 15s
 *   · 全局硬护栏：在飞 ≤180 · RPS ≤25
 *   · 熔断：同域名连续 6 次失败（超时/403/429）⇒ 暂停 40s ⇒ 半开 3 并发逐步恢复
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acquireTraffic,
  configureTraffic,
  createTaskScope,
  defaultTrafficConfig,
  domainBreakerState,
  noteTrafficResult,
  releaseTraffic,
  resetTraffic,
  trafficSnapshot,
} from '../net/traffic';

/** 把限额改小以便在测试里立刻触发（数值与生产不同，语义相同） */
function smallConfig(over: Partial<Parameters<typeof configureTraffic>[0]> = {}) {
  const base = defaultTrafficConfig();
  return {
    ...base,
    globalMaxConcurrent: 50,
    globalRps: 10_000,
    domainTotal: 3,
    domainPool: 2,
    breaker: { consecutiveFailures: 2, cooldownMs: 120, halfOpenConcurrency: 1, recoverStepMs: 30 },
    instant: { ...base.instant, perDomainPool: 2, taskConcurrent: 3, taskRps: 10_000, failCooldownMs: 0 },
    batch: { ...base.batch, perDomainPool: 2, taskConcurrent: 3, taskRps: 10_000, failCooldownMs: 0 },
    ...over,
  };
}

/** 若 promise 在 `ms` 内仍未 settle 则返回 true（= 确实被限住了） */
async function stillPending(p: Promise<unknown>, ms = 40): Promise<boolean> {
  let done = false;
  void p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await new Promise((r) => setTimeout(r, ms));
  return !done;
}

test('#200 域名总并发是**全局共享**的（不按任务独立计算）', async () => {
  configureTraffic(smallConfig({ domainTotal: 2, domainPool: 2, instant: { ...smallConfig().instant, perDomainPool: 9, taskConcurrent: 9 } }));
  const a = createTaskScope('instant');
  const b = createTaskScope('instant');
  const l1 = await acquireTraffic(a, 'x.test', 'detail');
  const l2 = await acquireTraffic(b, 'x.test', 'detail');
  const blocked = acquireTraffic(a, 'x.test', 'detail');
  assert.equal(await stillPending(blocked), true, '域名总并发已满（跨**两个不同任务**）⇒ 第三条必须排队');
  releaseTraffic(l1);
  const l3 = await blocked; // 腾出一个槽 ⇒ 立刻放行
  assert.ok(l3, '释放后应放行');
  releaseTraffic(l2);
  releaseTraffic(l3);
});

test('#200 详情池 / 正文池**独立计数、互不抢占**', async () => {
  configureTraffic(
    smallConfig({
      domainTotal: 2,
      domainPool: 1,
      instant: { ...smallConfig().instant, perDomainPool: 5, taskConcurrent: 9 },
    }),
  );
  const a = createTaskScope('instant');
  const d = await acquireTraffic(a, 'x.test', 'detail');
  // 详情池已占满(1/1)，但正文池是**另一个**池 ⇒ 应当立刻拿到
  const c = await acquireTraffic(a, 'x.test', 'content');
  assert.ok(c, '正文池必须独立于详情池');
  const blocked = acquireTraffic(a, 'x.test', 'detail');
  assert.equal(await stillPending(blocked), true, '同一池超过上限必须排队');
  releaseTraffic(c);
  releaseTraffic(d);
  // ★ 必须把排队的许可也排空：留着悬挂 promise 会让测试进程「事件循环已空但仍有未决 promise」
  releaseTraffic(await blocked);
});

test('#200 单任务总并发上限（即时档）', async () => {
  configureTraffic(
    smallConfig({
      domainTotal: 50,
      domainPool: 50,
      instant: { ...smallConfig().instant, perDomainPool: 50, taskConcurrent: 1 },
    }),
  );
  const a = createTaskScope('instant');
  const l1 = await acquireTraffic(a, 'x.test', 'detail');
  const blocked = acquireTraffic(a, 'y.test', 'detail'); // 不同域名，仍受**任务**总并发限制
  assert.equal(await stillPending(blocked), true, '任务总并发=1 ⇒ 第二个请求必须排队');
  releaseTraffic(l1);
  releaseTraffic(await blocked);
});

test('#200 单任务 RPS 上限', async () => {
  configureTraffic(
    smallConfig({
      domainTotal: 50,
      domainPool: 50,
      instant: { ...smallConfig().instant, perDomainPool: 50, taskConcurrent: 50, taskRps: 1 },
    }),
  );
  const a = createTaskScope('instant');
  const l1 = await acquireTraffic(a, 'x.test', 'detail');
  const blocked = acquireTraffic(a, 'x.test', 'detail');
  assert.equal(await stillPending(blocked, 60), true, 'RPS=1 ⇒ 同一秒内第二个请求必须等窗口滚动');
  releaseTraffic(l1);
  const l2 = await blocked;
  assert.ok(l2, '窗口滚过后应放行');
  releaseTraffic(l2);
});

test('#200 熔断：同域名连续失败达阈值 ⇒ 该域名被**全局**暂停', async () => {
  configureTraffic(smallConfig());
  assert.equal(domainBreakerState('bad.test').open, false);
  noteTrafficResult('bad.test', { ok: false, timedOut: true });
  assert.equal(domainBreakerState('bad.test').open, false, '1 次还不该熔断');
  noteTrafficResult('bad.test', { ok: false, timedOut: true });
  const st = domainBreakerState('bad.test');
  assert.equal(st.open, true, '连续 2 次（阈值）失败 ⇒ 必须熔断');
  assert.ok(st.waitMs > 0, '熔断应有剩余冷却时间');
});

test('#200 熔断只对「被站点拒」类计数：HTTP 404 不得触发', async () => {
  configureTraffic(smallConfig());
  for (let i = 0; i < 5; i++) noteTrafficResult('ok.test', { ok: false, status: 404 });
  assert.equal(domainBreakerState('ok.test').open, false, '404 是站点正常应答，不该熔断');
});

test('#200 一次成功即清零连续失败计数', async () => {
  configureTraffic(smallConfig());
  noteTrafficResult('f.test', { ok: false, timedOut: true });
  noteTrafficResult('f.test', { ok: true });
  noteTrafficResult('f.test', { ok: false, timedOut: true });
  assert.equal(domainBreakerState('f.test').open, false, '中间成功过 ⇒ 计数必须清零（能自愈）');
});

test('#200 冷却结束后**半开**：并发降到 halfOpenConcurrency 再逐步恢复', async () => {
  configureTraffic(smallConfig({ breaker: { consecutiveFailures: 1, cooldownMs: 50, halfOpenConcurrency: 1, recoverStepMs: 30 } }));
  noteTrafficResult('h.test', { ok: false, timedOut: true });
  assert.equal(domainBreakerState('h.test').open, true);
  await new Promise((r) => setTimeout(r, 70));
  const st = domainBreakerState('h.test');
  assert.equal(st.open, false, '冷却结束应解除熔断');
  assert.ok(st.limit <= 2, `半开期并发必须被压到很小（实得 ${st.limit}）`);
});

test('#200 熔断期内申请许可：等待时间超过本次预算时**直接报错**，不空转', async () => {
  configureTraffic(smallConfig({ breaker: { consecutiveFailures: 1, cooldownMs: 5000, halfOpenConcurrency: 1, recoverStepMs: 30 } }));
  noteTrafficResult('w.test', { ok: false, timedOut: true });
  const a = createTaskScope('instant');
  await assert.rejects(
    () => acquireTraffic(a, 'w.test', 'detail', { timeoutMs: 50 }),
    /熔断中/,
    '预算 50ms < 冷却 5000ms ⇒ 必须直接失败并说明原因（铁律 3：不静默跳过）',
  );
});

test('#200 快照暴露「占用 ≥80%」告警（参考设置要求）', async () => {
  configureTraffic(smallConfig({ globalMaxConcurrent: 2, domainTotal: 2, domainPool: 2 }));
  const a = createTaskScope('instant');
  const l1 = await acquireTraffic(a, 'a.test', 'detail');
  const l2 = await acquireTraffic(a, 'a.test', 'detail');
  const snap = trafficSnapshot();
  assert.equal(snap.global.inFlight, 2, '全局在飞应为 2');
  assert.ok(snap.warnings.length > 0, `达到 80% 应产生告警（实得 ${JSON.stringify(snap.warnings)}）`);
  releaseTraffic(l1);
  releaseTraffic(l2);
  assert.equal(trafficSnapshot().global.inFlight, 0, '释放后必须归零（socket 释放）');
});

test('#200 默认配置与参考设置一致（防止有人手滑改小/改大）', () => {
  resetTraffic();
  configureTraffic(null);
  const c = defaultTrafficConfig();
  assert.equal(c.globalMaxConcurrent, 180);
  assert.equal(c.globalRps, 25);
  assert.equal(c.domainTotal, 10, '单域名总并发严格 ≤10');
  assert.equal(c.instant.perDomainPool, 6);
  assert.equal(c.instant.taskConcurrent, 30);
  assert.equal(c.instant.taskRps, 5);
  assert.equal(c.instant.timeoutMs, 12_000);
  assert.equal(c.instant.retries, 2);
  assert.equal(c.instant.failCooldownMs, 200);
  assert.equal(c.batch.perDomainPool, 8);
  assert.equal(c.batch.taskConcurrent, 45);
  assert.equal(c.batch.taskRps, 8);
  assert.equal(c.batch.timeoutMs, 15_000);
  assert.equal(c.breaker.consecutiveFailures, 6);
  assert.equal(c.breaker.cooldownMs, 40_000);
  assert.equal(c.breaker.halfOpenConcurrency, 3);
});
