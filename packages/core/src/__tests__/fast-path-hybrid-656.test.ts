/**
 * `#656` **快路入口必须穿过混合求值器的包装层**（`#633` 快路此前 100% 是死的）。
 *
 * ## 事故（2026-10-27 用户实测日志）
 * `[toc] 1695 章目录 18.70s · conc=16 · worker · l1=0 worker=1694 fast=0`
 * —— 用户问「不是可以走 fast？」。查下来不是「没命中」，而是**根本没试过**：
 * `createJsEvaluator` 把 `__yueduFastExpr` 挂在它返回的 `evalFn` 上，
 * 而 `createHybridJsEvaluator` 为了 `expandJavaCollection` 又包了一层箭头函数 ⇒
 * 属性留在 `l1raw`、包装层没有；混合求值器里的判据 `(l1 as any).__yueduFastExpr` 恒 `undefined`。
 *
 * ## 为什么 `#633` 当初没发现
 * 它的实测（编译 1.15ms / 命中 0.007ms / worker 1.24ms）是拿 `createJsEvaluator` **单独**跑的，
 * 没经过混合求值器 —— 又一次「测的不是生产那条路」。
 *
 * ## 回归锁
 *  ① 有 worker 池（= 生产形态）时，纯表达式 ⇒ `fast` 计数 +1，`worker/l1` 都为 0；
 *  ② 值与原路（L1）逐字一致；
 *  ③ 引用绑定的脚本（`result`）**不许**被快路接走（否则就是语义漂移）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

/** 七猫官方源 `chapterUrl` 的真实形态（模板替换后）：纯表达式 + 白名单 java 纯函数 */
const PURE = `var cid='7621226646028160024';var cmd5='a1b2c3d4e5f6a7b8';
'data:;base64,'+java.base64Encode(cid+'/'+cmd5)+',{"type":"qm"}';`;

const fakePool = {
  __yueduWorkerPool: true,
  eval: async () => ({ ok: true, value: 'WORKER_SHOULD_NOT_RUN' }),
  stats: () => ({ size: 1, busy: 0, queued: 0 }),
} as unknown as never;

const routes = (ev: unknown): { l1: number; worker: number; fast: number } =>
  (ev as { __yueduRouteStats?: { l1: number; worker: number; fast: number } }).__yueduRouteStats ?? {
    l1: 0,
    worker: 0,
    fast: 0,
  };

test('#656 ①：带池（生产形态）时纯表达式走快路，不派给 worker', async () => {
  const ev = createHybridJsEvaluator({ variables: createVariableStore(), pool: fakePool });
  const got = await ev(PURE, {});
  const r = routes(ev);
  assert.equal(r.fast, 1, '快路计数必须 +1（#633 之前恒 0）');
  assert.equal(r.worker, 0, '纯表达式不该派给 worker');
  assert.equal(r.l1, 0, '纯表达式不该占主线程同步求值');
  assert.notEqual(got, 'WORKER_SHOULD_NOT_RUN', '不能落到 worker 桩');
});

test('#656 ②：快路结果与原路（L1 单独）逐字一致', async () => {
  const expect = 'data:;base64,' + Buffer.from('7621226646028160024/a1b2c3d4e5f6a7b8').toString('base64') + ',{"type":"qm"}';
  const hybrid = createHybridJsEvaluator({ variables: createVariableStore(), pool: fakePool });
  const fastGot = await hybrid(PURE, {});
  const l1Got = await createJsEvaluator({ variables: createVariableStore() })(PURE, {});
  assert.equal(fastGot, expect);
  assert.equal(l1Got, expect);
});

test('#656 ③：引用绑定的脚本不被快路接走（语义边界）', async () => {
  const ev = createHybridJsEvaluator({ variables: createVariableStore(), pool: fakePool });
  const out = await ev('result + "x"', { result: 'R' } as Record<string, unknown>);
  const r = routes(ev);
  assert.equal(r.fast, 0, '用 result 绑定的脚本必须原路走（快路白名单外）');
  // 桩池原样回传 `{ok,value}`（真实池会在上层解包）—— 这里只证明请求确实派给了 worker
  assert.ok(JSON.stringify(out).includes('WORKER_SHOULD_NOT_RUN'), '应派给 worker（本测试用桩顶替）');
});

test('#656 ④：入口在（无池时也不会被包装层吃掉）', () => {
  const ev = createHybridJsEvaluator({ variables: createVariableStore() });
  const carrier = (ev as unknown as { __yueduFastExpr?: unknown }).__yueduFastExpr;
  assert.equal(typeof carrier, 'function', '无池时返回的就是包装后的 l1，必须带快路入口');
});
