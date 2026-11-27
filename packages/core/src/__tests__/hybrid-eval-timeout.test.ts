/**
 * worker 求值的**分级超时**回归测试。
 *
 * ## 背景（这是上轮遗留没闭环的一处）
 * 之前把「同步 HTTP 超时」从 10s 调到 15s（因为站点响应实测在 2.1s~14.7s 之间抖动，10s 会把
 * 能出内容的源判成空 body）。但**只改了同步那边**：Phase 0.1 之后绝大多数含 `java.ajax` 的脚本
 * 都路由进 worker，而 worker 的求值超时用的是池的 `defaultTimeoutMs`（10s）—— 于是 worker 会先被
 * kill，报 `JS_TIMEOUT@parse`，15s 那个设置**在 worker 路径上等于没生效**。
 *
 * 真机现象：`51漫画` 分类条变成 `ERROR:JS_TIMEOUT@parse`（10063ms ≈ 10s 超时），
 * 而同一时刻手测站点有 14.7s 的响应。
 *
 * ## 修法
 * 分级超时：**含 HTTP 的脚本**给 `同步 HTTP 超时 + 5s`；**纯计算脚本**不给 → 仍受池默认值（10s）保护，
 * 避免死循环脚本长期占用 worker。
 *
 * 本文件用「假池」记录 `eval` 收到的选项来断言这条策略，不需要真的开 worker。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHybridJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

/**
 * `#633` 快路会把这些**纯计算**脚本接走（不再进 worker），而本文件断言的是
 * 「worker 路由下的超时策略」⇒ 必须显式关掉快路，否则测的就不是同一个东西了。
 */
process.env['YUEDU_JS_FASTPATH'] = '0';

interface EvalOptions {
  code: string;
  bindings: Record<string, unknown>;
  timeoutMs?: number;
}

/** 假池：只记录调用参数，不真的执行脚本 */
function makeFakePool(): { pool: never; calls: EvalOptions[] } {
  const calls: EvalOptions[] = [];
  const pool = {
    __yueduWorkerPool: true as const,
    eval: async (o: EvalOptions): Promise<string> => {
      calls.push(o);
      return '';
    },
  };
  return { pool: pool as never, calls };
}

function ev(pool: never, syncTimeoutMs?: number): (code: string, b: Record<string, unknown>) => unknown {
  return createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    ...(syncTimeoutMs === undefined ? {} : { syncTimeoutMs }),
  }) as (code: string, b: Record<string, unknown>) => unknown;
}

const BINDINGS: Record<string, unknown> = { baseUrl: 'https://src.test' };

test('worker 求值：不发 HTTP 的脚本不设 timeoutMs（沿用池默认硬超时）', async () => {
  const { pool, calls } = makeFakePool();
  await Promise.resolve(ev(pool, undefined)('var a = 1 + 1; a;', BINDINGS));
  assert.equal(calls.length, 1, '应路由到 worker');
  assert.equal(calls[0]!.timeoutMs, undefined, '纯计算脚本不应覆盖池默认超时（防死循环长期占 worker）');
});

test('worker 求值：含 java.ajax 的脚本超时 = 同步 HTTP 超时 + 5s', async () => {
  const { pool, calls } = makeFakePool();
  await Promise.resolve(ev(pool, undefined)('java.ajax("https://api.test/x");', BINDINGS));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.timeoutMs, 20_000, '缺省同步 HTTP 超时 15s → worker 求值 20s');
});

test('worker 求值：六种同步 HTTP API 都要触发分级超时', async () => {
  const apis = [
    'java.ajax("https://a.test")',
    'java.ajaxAll(["https://a.test"])',
    'java.post("https://a.test", "b")',
    'java.get("https://a.test")',
    'java.connect("https://a.test")',
    'java.head("https://a.test")',
    'java.getStrResponse("https://a.test")',
  ];
  for (const call of apis) {
    const { pool, calls } = makeFakePool();
    await Promise.resolve(ev(pool, undefined)(`${call};`, BINDINGS));
    assert.equal(calls[0]!.timeoutMs, 20_000, `${call} 应触发分级超时`);
  }
});

test('worker 求值：宿主自定义 syncTimeoutMs 时随之放大', async () => {
  const { pool, calls } = makeFakePool();
  await Promise.resolve(ev(pool, 30_000)('java.ajax("https://a.test");', BINDINGS));
  assert.equal(calls[0]!.timeoutMs, 35_000, '30000 + 5000');

  const { pool: pool2, calls: calls2 } = makeFakePool();
  await Promise.resolve(ev(pool2, 30_000)('var a = 1; a;', BINDINGS));
  assert.equal(calls2[0]!.timeoutMs, undefined, '自定义超时不应影响纯计算脚本');
});

test('不变量：含 HTTP 的 worker 求值超时必须严格大于同步 HTTP 超时', async () => {
  // 这条断言是给未来改数值的人看的：两者若相等或倒挂，worker 会先 kill，
  // 「同步超时可配」就等于没生效（本轮就是踩了这个）。
  const { pool, calls } = makeFakePool();
  await Promise.resolve(ev(pool, undefined)('java.ajax("https://a.test");', BINDINGS));
  const workerTimeout = calls[0]!.timeoutMs!;
  assert.ok(workerTimeout > 15_000, `worker 求值超时(${workerTimeout}) 必须 > 同步 HTTP 超时(15000)`);
});
