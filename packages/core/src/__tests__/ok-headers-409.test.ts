/**
 * `#409` 回归锁：`StrResponse.headers()` 必须是 **okhttp Headers 视图**（L1 与 worker 同面）。
 *
 * ## 缺陷（2026-10-12 真源实测，18AV）
 * 其 jsLib 的 `rrcheck()` 用 `java.connect(u).headers().values("Set-Cookie")` 过
 * 「年满18岁声明」闸（Discuz `#fwin_dialog_submit` 的 onclick 带目标 URL）。
 * 本仓 `java.ajax/connect/get/post/head` 的出口（L1 `syncHttp` / worker `strResponse`）
 * 此前 `headers()` 返回**普通对象** ⇒ 抛 `TypeError: ....values is not a function`
 * ⇒ rrcheck 整体崩 ⇒ 列表规则 0 条 ⇒ 用户可见 = 「分类下无内容卡片 + SELECTOR_MISS@parse」。
 *
 * 语料面：`data/sources/` 里 `headers().values/get/names/toMultimap` 共 **3 处 / 2 源**。
 *
 * ⚠️ 断言分三层：① 纯函数；② **L1** 的 `java.connect(...)`；③ **worker** 同一句。
 * 只测纯函数会漏掉「出口没接上」这个真正的断点（本缺陷正是如此）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { okHeaders } from '../selector/ok-headers';
import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import type { SyncHttpResponse } from '../selector/js';

const COOKIE = 'd652abc=90aa11; path=/';

function fakeTransport(): SyncHttpResponse {
  return { status: 200, headers: { 'Set-Cookie': COOKIE, 'content-type': 'text/html' }, setCookie: [COOKIE], body: 'hi' };
}

test('#409 纯函数：okHeaders 给出 okhttp 面（get/names/values/size/toMultimap）+ 小写键直读', () => {
  const h = okHeaders({ 'Set-Cookie': COOKIE, 'Content-Type': 'text/html' });
  assert.deepEqual(h['values'] instanceof Function && (h['values'] as (n: string) => string[])('set-cookie'), [COOKIE]);
  assert.equal((h['get'] as (n: string) => string | null)('SET-COOKIE'), COOKIE, 'get 必须大小写不敏感');
  assert.equal(h['size'] instanceof Function ? (h['size'] as () => number)() : -1, 2);
  assert.deepEqual(h['names'] instanceof Function ? (h['names'] as () => string[])() : [], ['set-cookie', 'content-type']);
  assert.equal((h['get'] as (n: string) => string | null)('nope'), null, '未命中 = null（okhttp 语义）');
  assert.deepEqual((h['values'] as (n: string) => string[])('nope'), [], '未命中 = 空数组');
  // 兼容面：小写键直读（旧写法 headers()['content-type'] 照旧可用 ⇒ 零回归）
  assert.equal(h['content-type'], 'text/html');
});

test('#409 L1：java.connect(...).headers().values("Set-Cookie") 必须可用（旧实现抛 values is not a function）', () => {
  const variables = createVariableStore();
  const ev = createJsEvaluator({ variables, syncFetch: fakeTransport });
  const out = ev(
    'var h = java.connect("https://18av.test/zh/x/1.html").headers();' +
      'JSON.stringify({v: h.values("Set-Cookie"), g: h.get("set-cookie"), n: h.size()})',
    { $: '' },
  );
  const r = JSON.parse(String(out)) as { v: string[]; g: string; n: number };
  assert.deepEqual(r.v, [COOKIE], 'values("Set-Cookie") 必须返回数组');
  assert.equal(r.g, COOKIE);
  assert.equal(r.n, 2);
});

test('#409 worker：同一句在 worker 路径也必须可用（两路不许分岔）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const variables = createVariableStore();
  const st = { evals: 0 };
  const rawPool = pool as unknown as Record<string, unknown>;
  const counting = new Proxy(rawPool, {
    get(t, p: string) {
      const v = Reflect.get(t, p) as unknown;
      if (p === 'eval') {
        return (...a: unknown[]) => {
          st.evals++;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
  const ev = createHybridJsEvaluator({
    variables,
    pool: counting as never,
    // worker 的 java.connect 走 http RPC —— 这里注入响应头（含 Set-Cookie）
    http: async () => ({ status: 200, headers: { 'Set-Cookie': COOKIE }, body: 'hi' }),
  });
  try {
    const out = await Promise.resolve(
      ev('var h = java.connect("https://18av.test/x").headers(); JSON.stringify({v: h.values("Set-Cookie"), n: h.size()})', { $: '' }),
    );
    const r = JSON.parse(String(out)) as { v: string[]; n: number };
    assert.ok(st.evals > 0, '必须真的走 worker（若为 0 说明回落 L1，本条空转）');
    assert.deepEqual(r.v, [COOKIE], 'worker 侧 values("Set-Cookie") 也必须返回数组');
    assert.equal(r.n, 1);
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});