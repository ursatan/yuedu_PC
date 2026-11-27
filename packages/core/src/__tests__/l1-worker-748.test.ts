/**
 * `#748` D1：纯 `java.ajax` / `java.head` + 文本规则的 L1 子集下放到 worker。
 *
 * 锁四件事：
 *  1. 默认关（`YUEDU_L1_WORKER` 未设）：不可克隆绑定仍在 ⇒ 路由 L1，零行为变化；
 *  2. `=1` 且绑定不可克隆但**脚本没引用** ⇒ 丢掉该绑定后下发 worker，宿主 HTTP 被调用；
 *  3. 非纯子集（DOM 方法 / cookie / `java.getString` / Java 类桥）即使 `=1` 也回落 L1；
 *  4. 返回值与异常语义在两条路由上一致（同 body 同 message）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import type { SyncHttpRequest, SyncHttpResponse } from '../selector/js';

type Ev = ((code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>) & {
  __yueduRouteStats?: { l1: number; worker: number; fast: number };
};

/** 不可克隆（带函数成员）且脚本刻意不引用的宿主 DOM 绑定 */
function domish(): Record<string, unknown> {
  return { text: () => 'dom', select: () => [], outerHTML: '<div/>' };
}

function stats(ev: Ev): { l1: number; worker: number; fast: number } {
  return ev.__yueduRouteStats ?? { l1: 0, worker: 0, fast: 0 };
}

function syncStub(calls: string[], body = '{"ok":1}'): (r: SyncHttpRequest) => SyncHttpResponse {
  return (r) => {
    calls.push(r.url);
    return { status: 200, headers: {}, setCookie: [], body };
  };
}

function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env['YUEDU_L1_WORKER'];
  if (value === undefined) delete process.env['YUEDU_L1_WORKER'];
  else process.env['YUEDU_L1_WORKER'] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env['YUEDU_L1_WORKER'];
    else process.env['YUEDU_L1_WORKER'] = prev;
  });
}

test('D1 默认关：不可克隆绑定仍走 L1，宿主同步 HTTP 被调用', async () => {
  await withEnv(undefined, async () => {
    const vars = createVariableStore();
    const pool = createWorkerSandboxPool({ size: 1 });
    const syncCalls: string[] = [];
    const ev = createHybridJsEvaluator({
      variables: vars,
      pool,
      syncFetch: syncStub(syncCalls),
    }) as Ev;
    const out = await Promise.resolve(ev('java.ajax("https://slow.test/x")', {
      result: domish(), $: domish(), src: domish(),
    }));
    assert.equal(String(out), '{"ok":1}');
    assert.deepEqual(syncCalls, ['https://slow.test/x']);
    assert.equal(stats(ev).l1, 1, '默认关必须落 L1');
    assert.equal(stats(ev).worker, 0);
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });
});

test('D1 开：未引用的不可克隆绑定被丢弃 ⇒ worker 执行，宿主同步 HTTP 不被调用', async () => {
  await withEnv('1', async () => {
    const vars = createVariableStore();
    const pool = createWorkerSandboxPool({ size: 1 });
    const syncCalls: string[] = [];
    const httpCalls: string[] = [];
    const ev = createHybridJsEvaluator({
      variables: vars,
      pool,
      syncFetch: syncStub(syncCalls),
      http: async (r) => {
        httpCalls.push(r.url);
        return { status: 200, headers: {}, body: '{"ok":1}' };
      },
    }) as Ev;
    const out = await Promise.resolve(ev('java.ajax("https://slow.test/x")', {
      result: domish(), $: domish(), src: domish(),
    }));
    assert.equal(String(out), '{"ok":1}');
    assert.deepEqual(syncCalls, [], '宿主同步 HTTP 一次都不该走');
    assert.deepEqual(httpCalls, ['https://slow.test/x'], '应走 worker→宿主异步 HTTP');
    assert.equal(stats(ev).worker, 1);
    assert.equal(stats(ev).l1, 0);
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });
});

test('D1 开：纯文本/正则/JSON（无 HTTP）也逐字一致', async () => {
  await withEnv('1', async () => {
    const vars = createVariableStore();
    const pool = createWorkerSandboxPool({ size: 1 });
    const ev = createHybridJsEvaluator({ variables: vars, pool }) as Ev;
    const out = await Promise.resolve(ev(
      'JSON.stringify(("abcdef").replace(/c/, "").match(/[a-z]+/g).slice(0, 2));',
      { result: domish() },
    ));
    assert.equal(String(out), '["abdef"]');
    assert.equal(stats(ev).worker, 1);
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });
});

test('D1 开：非纯子集一律回落 L1', async () => {
  await withEnv('1', async () => {
    const vars = createVariableStore();
    const pool = createWorkerSandboxPool({ size: 1 });
    const syncCalls: string[] = [];
    const ev = createHybridJsEvaluator({
      variables: vars,
      pool,
      syncFetch: syncStub(syncCalls),
    }) as Ev;
    const cases = [
      // 在绑定上调 DOM 方法 ⇒ 不可丢 + DOM 上下文
      'result.text()',
      // cookie 写
      'cookie.setCookie("a","b"); "x"',
      // 规则桥（会回宿主 AnalyzeRule）
      'java.getString("tag.a@href")',
      // Java 类桥
      'var x = Packages.java.lang.String("a"); String(x)',
      // 非 ajax/head 的网络 API
      'java.post("https://slow.test/p", "a=1")',
      // 动态取值
      'this["res"+"ult"]',
    ];
    for (const code of cases) {
      const before = stats(ev).l1;
      try {
        await Promise.resolve(ev(code, { result: domish(), $: domish(), src: domish() }));
      } catch {
        // 回落的脚本在宿主里可能因缺 `cookie` 等绑定而抛错；本用例只关心路由
      }
      assert.equal(stats(ev).l1, before + 1, `应回落 L1：${code}`);
    }
    assert.equal(stats(ev).worker, 0);
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });
});

test('D1 开：异常消息与 L1 一致', async () => {
  await withEnv(undefined, async () => {
    const vars = createVariableStore();
    const pool = createWorkerSandboxPool({ size: 1 });
    const ev = createHybridJsEvaluator({ variables: vars, pool }) as Ev;
    const code = 'throw new Error("boom-748")';
    let l1Msg = '';
    try {
      await Promise.resolve(ev(code, { result: domish() }));
    } catch (e) {
      l1Msg = (e as Error).message;
    }
    assert.ok(l1Msg.includes('boom-748'), `L1 异常应含原文：${l1Msg}`);
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  await withEnv('1', async () => {
    const vars = createVariableStore();
    const pool = createWorkerSandboxPool({ size: 1 });
    const ev = createHybridJsEvaluator({ variables: vars, pool }) as Ev;
    const code = 'throw new Error("boom-748")';
    let workerMsg = '';
    try {
      await Promise.resolve(ev(code, { result: domish() }));
    } catch (e) {
      workerMsg = (e as Error).message;
    }
    assert.ok(workerMsg.includes('boom-748'), `worker 异常应含原文：${workerMsg}`);
    assert.equal(stats(ev).worker, 1);
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });
});
