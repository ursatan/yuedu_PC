/**
 * `#598` **顶层 `return`**（全量基线 2026-10-24：可乐小说 / 得奇小说，2 源）。
 *
 * 上游 Rhino 把 `<js>` / `@js:` 规则当**函数体**编译 ⇒ 顶层 `return` 合法
 * （源里常见：`{ let token = …; return {…} }`）。而我们的 code 是 `eval(...)` 执行的，
 * **eval 是 Script 上下文 ⇒ 顶层 `return` 报 `Illegal return statement`**。
 *
 * 判据不能用 `new Function(src)` 预检：函数体上下文**允许**顶层 return（`new Function('return 1')` 不抛），
 * 所以「编译预检再决定包不包」判不出来（踩过）。改用**失败后重试**：只有真抛
 * `Illegal return statement` 才把整段包 IIFE 重跑 —— 能跑的脚本零额外开销。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/** 源里的真实形态：块内顶层 return（`Illegal return statement｜运行期 3:16 | return {`） */
const BLOCK_RETURN = '{ var token = 41; return { v: token + 1 }; }';

test('L1：块内顶层 return ⇒ 包 IIFE 后拿到返回值', () => {
  const ev = createJsEvaluator({ variables: createVariableStore() });
  const out = ev(BLOCK_RETURN, {});
  assert.deepEqual(out, { v: 42 });
});

test('L1：普通脚本不受影响（函数体内的 return 不重试）', () => {
  const ev = createJsEvaluator({ variables: createVariableStore() });
  assert.equal(String(ev('(function(){ return "in"; })()', {})), 'in');
});

test('worker：同一条重试判据', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  try {
    const ev = createHybridJsEvaluator({
      variables: createVariableStore(),
      pool,
      http: async () => ({ status: 200, headers: {}, body: '{}' }),
    }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
    const out = await Promise.resolve(ev(BLOCK_RETURN, {}));
    // worker 侧以「可发送化」形态回流：对象即可
    assert.deepEqual(out, { v: 42 });
  } finally {
    await (pool as unknown as { close?: () => Promise<void> }).close?.();
  }
});
