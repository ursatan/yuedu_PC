/**
 * `#756` C **交互优先级兜底**回归锁。
 *
 * 用户观感「detail(stream) 8~9s」的根因：`#747` 的图片解密让路只认 `/api/run` 的前台计数，
 * 而前端点详情走 `/api/run/stream` ⇒ 没登记 ⇒ 主线程被 300ms 同步解密块持续挤占。
 * 受控实验（1612 章本地目录 + 40 张 300ms 解密图）：`/api/run` 1.1~2.4s，
 * `/api/run/stream` 6.8~8.4s（基线 0.8~1.0s）。
 *
 * 这里锁两层：
 *   · 闸本身的行为（忙碌等待/封顶/计数）；
 *   · 路由接线（三条交互路径都必须成对 enter/leave，`/api/diag` 必须暴露 priority）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createForegroundGate } from '../foreground-gate';

const INDEX = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');

function routeBlock(startMarker: string, endMarker: string): string {
  const a = INDEX.indexOf(startMarker);
  assert.ok(a >= 0, `找不到路由 ${startMarker}`);
  const b = INDEX.indexOf(endMarker, a);
  assert.ok(b > a, `找不到 ${startMarker} 的结束标记`);
  return INDEX.slice(a, b);
}

test('#756 闸：enter/leave 与峰值；resetCounters 只清累计量', () => {
  const gate = createForegroundGate();
  assert.equal(gate.snapshot().busy, 0);
  gate.enter();
  gate.enter();
  assert.deepEqual({ busy: gate.snapshot().busy, peak: gate.snapshot().peak }, { busy: 2, peak: 2 });
  gate.leave();
  gate.leave();
  gate.leave(); // 多减一次不能变负数（路由 finally 与应用层重复调用要安全）
  assert.equal(gate.snapshot().busy, 0);
  assert.equal(gate.snapshot().peak, 2);
  gate.resetCounters();
  assert.equal(gate.snapshot().peak, 0);
});

test('#756 闸：空闲立即返回 0；忙碌时等到 leave；封顶后放行', async () => {
  const gate = createForegroundGate({ pollMs: 5, yieldMaxMs: 200 });
  assert.equal(await gate.waitIdle(), 0);
  gate.enter();
  setTimeout(() => gate.leave(), 20);
  const waited = await gate.waitIdle();
  assert.ok(waited >= 10, `应在前台忙时等待，实际 ${waited}ms`);
  // 一直忙：最多等 yieldMaxMs 就放行，不能无限挂起（避免图片永远解不出来）
  gate.enter();
  const capped = await gate.waitIdle(40);
  assert.ok(capped >= 30 && capped < 400, `封顶等待异常：${capped}ms`);
  gate.leave();
  gate.leave();
});

test('#756 闸：解密队列/执行/让路计数进 snapshot', () => {
  const gate = createForegroundGate();
  gate.noteDecodeQueued();
  gate.noteDecodeQueued();
  gate.noteDecodeRun();
  gate.noteDecodeDeferred(120);
  gate.noteDecodeDeferred(0); // 立即放行不算「被推迟」
  const s = gate.snapshot().decode;
  assert.deepEqual(s, { queue: 2, peakQueue: 2, runs: 1, deferred: 1, deferredMs: 120 });
  gate.noteDecodeDone();
  assert.equal(gate.snapshot().decode.queue, 1);
  gate.resetCounters();
  assert.deepEqual(gate.snapshot().decode, { queue: 1, peakQueue: 0, runs: 0, deferred: 0, deferredMs: 0 });
});

test('#756 接线：/api/run 与 /api/run/stream 都登记前台在飞', () => {
  const run = routeBlock("'/api/run',", '#583');
  assert.match(run, /foregroundGate\.enter\(\)/, '/api/run 必须 enter');
  assert.match(run, /foregroundGate\.leave\(\)/, '/api/run 必须 finally leave');
  const stream = routeBlock("'/api/run/stream'", '// 多源聚合搜索');
  assert.match(stream, /foregroundGate\.enter\(\)/, '/api/run/stream 漏登记会复现 8~9s');
  assert.match(stream, /foregroundGate\.leave\(\)/, '/api/run/stream 必须在 finally 释放');
});

test('#756 接线：聚合搜索登记前台；图片解密走 waitIdle；diag 暴露 priority', () => {
  const agg = routeBlock("'/api/aggregate/search'", '// 静态资源');
  assert.match(agg, /foregroundGate\.enter\(\)/);
  assert.match(agg, /foregroundGate\.leave\(\)/);
  assert.match(INDEX, /foregroundGate\.waitIdle\(\)/, '图片解密必须先等前台空闲');
  assert.match(INDEX, /priority: foregroundGate\.snapshot\(\)/, '/api/diag 必须暴露 priority');
  assert.match(INDEX, /foregroundGate\.resetCounters\(\)/, '?reset=1 必须清优先级计数');
});
