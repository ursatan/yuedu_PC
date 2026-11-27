/**
 * `#779` **content 动作的纯计算求值预算**（20s）回归测试。
 *
 * 背景：content 规则常是「大批量纯计算」（哔咔 40 张图逐张签名/解码，不含 `java.ajax`），
 * 吃不到 `syncTimeoutMs + 5s` 分级 ⇒ 落 worker 池默认 10s ⇒ `JS_TIMEOUT@parse`。
 * 修法：hub 按 `action==='content'` 注入 `EngineContext.jsComputeTimeoutMs`（默认 20s），
 * 引擎透传给 `createHybridJsEvaluator({ computeTimeoutMs })`。
 *
 * 本文件用「假池」只断言下发给 worker 的 `timeoutMs`：
 *  · content（带 computeTimeoutMs）纯计算脚本 → 20s；
 *  · 不带（detail/搜索/普通求值）→ 不覆盖 ⇒ 池默认 10s；
 *  · 含 HTTP 的脚本不受影响（仍 `syncTimeoutMs + 5s`）；
 *  · 环境开关 `YUEDU_JS_CONTENT_TIMEOUT_MS` 可回退（`0` = 回退到池默认）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { contentComputeEvalTimeoutMs, createHybridJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

/** 快路会把纯表达式接走（不进 worker），这里要测的就是 worker 路由的超时策略 */
process.env['YUEDU_JS_FASTPATH'] = '0';

interface EvalOptions {
  code: string;
  bindings: Record<string, unknown>;
  timeoutMs?: number;
}

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

function ev(pool: never, extra: { computeTimeoutMs?: number; syncTimeoutMs?: number } = {}): (
  code: string,
  b: Record<string, unknown>,
) => unknown {
  return createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    ...(extra.computeTimeoutMs === undefined ? {} : { computeTimeoutMs: extra.computeTimeoutMs }),
    ...(extra.syncTimeoutMs === undefined ? {} : { syncTimeoutMs: extra.syncTimeoutMs }),
  }) as (code: string, b: Record<string, unknown>) => unknown;
}

const BINDINGS: Record<string, unknown> = { baseUrl: 'https://src.test' };
const PURE_SCRIPT = 'var a = 1 + 1; a;';

test('#779 开关：默认 20s，可用 YUEDU_JS_CONTENT_TIMEOUT_MS 覆盖/回退', () => {
  const prev = process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'];
  try {
    delete process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'];
    assert.equal(contentComputeEvalTimeoutMs(), 20_000, '默认按用户决定 20s');

    process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'] = '10000';
    assert.equal(contentComputeEvalTimeoutMs(), 10_000, '一行改回 10s');

    process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'] = '0';
    assert.equal(contentComputeEvalTimeoutMs(), undefined, '0 = 不覆盖（池默认 10s）');

    process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'] = 'abc';
    assert.equal(contentComputeEvalTimeoutMs(), undefined, '非法值 = 不覆盖（安全回退）');
  } finally {
    if (prev === undefined) delete process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'];
    else process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'] = prev;
  }
});

test('#779 content：纯计算脚本下发 20s 求值预算', async () => {
  const { pool, calls } = makeFakePool();
  await Promise.resolve(ev(pool, { computeTimeoutMs: 20_000 })(PURE_SCRIPT, BINDINGS));
  assert.equal(calls.length, 1, '应路由到 worker');
  assert.equal(calls[0]!.timeoutMs, 20_000, 'content 的纯计算脚本走 20s');
});

test('#779 非 content：不传 computeTimeoutMs ⇒ 仍是池默认 10s（不覆盖）', async () => {
  const { pool, calls } = makeFakePool();
  await Promise.resolve(ev(pool)(PURE_SCRIPT, BINDINGS));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.timeoutMs, undefined, 'detail/搜索/普通求值不得被 content 预算波及');
});

test('#779 含 HTTP 的脚本不受 content 预算影响（仍 syncTimeoutMs + 5s）', async () => {
  const { pool, calls } = makeFakePool();
  await Promise.resolve(
    ev(pool, { computeTimeoutMs: 20_000, syncTimeoutMs: 30_000 })('java.ajax("https://api.test/x");', BINDINGS),
  );
  assert.equal(calls[0]!.timeoutMs, 35_000, 'HTTP 分级优先：30000 + 5000（不是 20000）');
});

test('#779 回退后 content 仍是池默认 10s', async () => {
  const prev = process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'];
  try {
    process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'] = '0';
    // hub 拿到 undefined ⇒ 引擎不传 computeTimeoutMs（等价于这里不传）
    const ms = contentComputeEvalTimeoutMs();
    assert.equal(ms, undefined);
    const { pool, calls } = makeFakePool();
    await Promise.resolve(ev(pool, ms === undefined ? {} : { computeTimeoutMs: ms })(PURE_SCRIPT, BINDINGS));
    assert.equal(calls[0]!.timeoutMs, undefined, '回退后回到池默认 10s（timeoutMs 不覆盖）');
  } finally {
    if (prev === undefined) delete process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'];
    else process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'] = prev;
  }
});
