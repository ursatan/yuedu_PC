/**
 * `#460` 卡死看门狗的**行为证明**（真起线程，真把主线程按住）。
 *
 * ## 用户原话（2026-10-15）
 * 「苹果MCS·影视小说聚合仍会卡离线…显示离线，长时间不恢复，只能关闭服务重启；**cmd 窗口无任何信息**。」
 *
 * 这条报障只有两种可能，而前端看到的**一模一样**：
 *  · **同步阻塞**（`Atomics.wait` / `execFileSync` 按住主线程）⇒ 连 `/api/sources` 都不答；
 *  · **异步饿死**（都在等在飞）⇒ 服务还在答，只是慢。
 * ⇒ 判据 = 主线程心跳还在不在，而这**只能由独立线程来量**。
 *
 * 本测试就是证明它测得出来：主线程自己 `Atomics.wait` 按住 2.2s，
 * 看门狗（另一个线程）必须在 staleMs 内报出 `[stall] stall`，并在恢复后报 `recover`。
 * 反过来也锁住「循环活着时不得误报」——否则这份取证就是噪音。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { disposeStallWatch, inflightSnapshot, startStallWatch, trackStart } from '../stall-watch';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** 真·按住主线程（同步语义，与 java.ajax / execFileSync 同一条路） */
const blockMainThread = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

test('#460 主线程被同步按住 ⇒ 看门狗报 stall；恢复 ⇒ 报 recover；快照带在飞动作', async () => {
  const report = join(tmpdir(), `yuedu-stall-${Date.now()}.log`);
  startStallWatch({ reportFile: report, staleMs: 1200, slowMs: 4000 });
  const end = trackStart('src:probe category');
  await sleep(400); // 让心跳先跑几拍（否则第一拍就是「从来没动过」）

  blockMainThread(2200); // ← 主线程在这里彻底停摆
  await sleep(600);      // 看门狗（独立线程）应已判定停摆并落盘

  const afterStall = readFileSync(report, 'utf8');
  assert.match(afterStall, /\[stall\] stall ms=/, '主线程停摆必须被看门狗抓到并写进报告');
  assert.match(afterStall, /inflight=src:probe category@\d+s/, '报告必须带上「卡死前在飞的是哪个源的哪个动作」');

  await sleep(800); // 心跳恢复
  const afterRecover = readFileSync(report, 'utf8');
  assert.match(afterRecover, /\[stall\] recover ms=/, '恢复也要留痕（否则只能看到半截现场）');

  end();
  assert.equal(inflightSnapshot(), '', '结束登记后快照必须清空（否则会留下假现场）');
  await disposeStallWatch();
  rmSync(report, { force: true });
});

test('#460 循环健康时不得误报（这份取证不能是噪音）', async () => {
  const report = join(tmpdir(), `yuedu-stall-ok-${Date.now()}.log`);
  startStallWatch({ reportFile: report, staleMs: 1200, slowMs: 4000 });
  await sleep(2500); // 主线程一直健康
  // 健康期间**连文件都不该被创建**（看门狗只在判定停摆时才写）
  assert.equal(existsSync(report), false, '健康期间不得产生任何报告（否则这份取证就是噪音）');
  await disposeStallWatch();
  rmSync(report, { force: true });
});
