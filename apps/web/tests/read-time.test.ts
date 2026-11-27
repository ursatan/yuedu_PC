/**
 * 阅读时长计时器的回归锁（`#144`）—— 全部状态注入，假时钟驱动。
 *
 * 语义对齐上游 `ReadBook.upReadTime()`（`ReadBook.kt:616-627`）：
 * 结算即重启、门控第一行、墙钟时间；外加本仓的「失败攒账、成功冲账」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReadTimeMeter, type ReadTimeDeps } from '../src/utils/read-time';

function makeDeps(over: Partial<ReadTimeDeps> = {}) {
  let t = 10_000;
  let pending = 0;
  const puts: Array<{ bookName: string; author: string | undefined; deltaMs: number }> = [];
  const deps: ReadTimeDeps = {
    now: () => t,
    getPendingMs: () => pending,
    setPendingMs: (ms) => {
      pending = ms;
    },
    put: (bookName, author, deltaMs) => {
      puts.push({ bookName, author, deltaMs });
      return Promise.resolve();
    },
    enabled: () => true,
    minFlushMs: 1000,
    ...over,
  };
  return {
    deps, puts,
    tick(ms: number) {
      t += ms;
    },
    get pending() {
      return pending;
    },
    failNextPut(err: unknown) {
      const original = deps.put;
      deps.put = (b, a, ms) => {
        deps.put = original; // 只失败下一次，之后恢复
        return Promise.reject(err);
      };
    },
  };
}

test('#144 翻章结算 = 结算即重启（对齐上游 upReadTime 的 readStartTime = now）', async () => {
  const d = makeDeps();
  const m = createReadTimeMeter(d.deps);
  m.begin({ bookName: '甲', author: '张三' });
  d.tick(30_000);
  m.lap(); // 翻章：结算 30s，重启
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(d.puts.length, 1);
  assert.equal(d.puts[0]?.deltaMs, 30_000);
  assert.equal(d.puts[0]?.bookName, '甲');
  d.tick(10_000);
  assert.equal(m.unsentMs(), 10_000, 'lap 后表必须继续走（新一段）');
  m.end();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(d.puts[1]?.deltaMs, 10_000, 'end 把新一段结算掉');
});

test('#144 门控 enableReadRecord=false：连表都不走（上游第一行 return）', () => {
  const d = makeDeps({ enabled: () => false });
  const m = createReadTimeMeter(d.deps);
  m.begin({ bookName: '甲' });
  d.tick(60_000);
  assert.equal(m.unsentMs(), 0, '关闭时 begin 不启动表');
  m.lap();
  m.end();
  assert.equal(d.puts.length, 0, '关闭时不许有任何上报');
});

test('#144 上报失败 ⇒ 攒账（pending 连同本段保留），下次结算先冲旧账', async () => {
  const d = makeDeps();
  const m = createReadTimeMeter(d.deps);
  m.begin({ bookName: '甲' });
  d.tick(20_000);
  d.failNextPut(new Error('offline'));
  m.lap(); // 失败 ⇒ pending = 20s
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(d.pending, 20_000);
  d.tick(15_000);
  m.lap(); // 成功 ⇒ 发 20+15=35s
  await Promise.resolve();
  await Promise.resolve();
  // 失败那次走的是 wrapped put（不进 puts 记录）⇒ 第二次成功的是 puts[0]
  assert.equal(d.puts.length, 1, '失败的请求不留在 puts（它的账在 pending 里）');
  assert.equal(d.puts[0]?.deltaMs, 35_000, '必须先冲旧账再发新账');
  assert.equal(d.pending, 0, '成功后 pending 清零');
});

test('#144 碎片不足 minFlushMs 不发请求（攒着凑），凑满后一次发出', async () => {
  const d = makeDeps();
  const m = createReadTimeMeter(d.deps);
  m.begin({ bookName: '甲' });
  d.tick(400);
  m.lap(); // 400ms < 1000 ⇒ 攒
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(d.puts.length, 0, '碎片不许触发请求');
  assert.equal(d.pending, 400);
  d.tick(700);
  m.end(); // 400+700=1100 ≥ 1000 ⇒ 发
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(d.puts.length, 1);
  assert.equal(d.puts[0]?.deltaMs, 1100);
});

test('#144 pause/resume：页面隐藏结算停表，恢复可见且阅读界面开着才重启', async () => {
  const d = makeDeps();
  const m = createReadTimeMeter(d.deps);
  m.begin({ bookName: '甲' });
  d.tick(25_000);
  m.pause(); // 隐藏：结算 25s，停表
  await Promise.resolve();
  await Promise.resolve();
  d.tick(600_000); // 隐藏期间
  m.resume();
  assert.equal(m.unsentMs(), 0, '阅读界面已关 ⇒ resume 不重启表');
  // 再开一本：resume 前提是 active
  m.begin({ bookName: '乙' });
  d.tick(8_000);
  m.pause();
  await Promise.resolve();
  await Promise.resolve();
  m.resume();
  d.tick(5_000);
  assert.equal(m.unsentMs(), 5_000, '阅读中恢复可见 ⇒ 表继续走');
  m.end();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(d.puts.at(-1)?.bookName, '乙');
});

test('#144 中途换书：结算挂到新书上（旧书的那段已在 lap/end 时发出）', async () => {
  const d = makeDeps();
  const m = createReadTimeMeter(d.deps);
  m.begin({ bookName: '甲', author: 'A' });
  d.tick(12_000);
  m.end(); // 甲的 12s 结算
  await Promise.resolve();
  await Promise.resolve();
  m.begin({ bookName: '乙', author: 'B' });
  d.tick(30_000);
  m.end();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    d.puts.map((p) => [p.bookName, p.deltaMs]),
    [['甲', 12_000], ['乙', 30_000]],
  );
  assert.equal(d.puts[0]?.author, 'A');
  assert.equal(d.puts[1]?.author, 'B');
});
