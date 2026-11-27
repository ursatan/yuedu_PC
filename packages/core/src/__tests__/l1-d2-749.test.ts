/**
 * `#749` D2：`curl` 兜底收口 + L1 单段硬超时 + `/api/diag` 路由计数。
 *
 * 这里锁三件事（每条都对应一个「默认值为什么这样定」的问题）：
 *  1. worker 链路失败只**同机制重试一次**，`execFileSync curl` 默认不参与回退（否则「异步失败 ⇒ 同步再冻」）；
 *  2. L1 单段到点抛 `L1_TIMEOUT`，**与 worker 的 `JS_TIMEOUT` 区分**（两类问题修法不同）；
 *  3. `l1w-drop` / 回落原因分布能进 `/api/diag`（默认开 `YUEDU_L1_WORKER` 的数据依据）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator, createJsEvaluator, L1EvalTimeoutError } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import { defaultSyncFetch, __setSyncFetchDisabledForTest, __setWorkerSyncFetchForTest } from '../net/sync-fetch-worker';
import { l1StatsSnapshot, resetL1Stats } from '../diag/l1-stats';
import { blockCounters } from '../diag/block-stats';
import type { SyncHttpRequest, SyncHttpResponse } from '../selector/js';

type Ev = ((code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>) & {
  __yueduRouteStats?: { l1: number; worker: number; fast: number };
};

function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    });
}

/** 同步阻塞一小段：模拟「一次卡住的同步 HTTP」（L1 判定的唯一阻塞面） */
function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function req(): SyncHttpRequest {
  return { method: 'GET', url: 'http://127.0.0.1:1/', headers: {}, timeoutMs: 1000 };
}

test('D2 ①：worker 链路失败 ⇒ 同机制重试一次；默认不回落 curl', async () => {
  await withEnv('YUEDU_CURL_FALLBACK', undefined, () => {
    resetL1Stats();
    let calls = 0;
    __setWorkerSyncFetchForTest(() => {
      calls += 1;
      return { status: 0, headers: {}, setCookie: [], body: '', yueduLinkFail: true };
    });
    const r = defaultSyncFetch(req());
    __setWorkerSyncFetchForTest(null);
    assert.equal(calls, 2, '链路失败必须重试**一次**（不是零次也不是无限次）');
    assert.equal(r.status, 0);
    assert.equal(r.body, '');
    const s = l1StatsSnapshot();
    assert.equal(s.curl.fallback, 0, '默认不得起 curl');
    assert.equal(s.curl.blocked, 1);
    assert.equal(s.curl.reasons['blocked:worker-link-fail'], 1);
  });
});

test('D2 ①：链路失败后重试成功 ⇒ 返回第二次结果，不记 curl', async () => {
  await withEnv('YUEDU_CURL_FALLBACK', undefined, () => {
    resetL1Stats();
    let calls = 0;
    __setWorkerSyncFetchForTest(() => {
      calls += 1;
      if (calls === 1) return { status: 0, headers: {}, setCookie: [], body: '', yueduLinkFail: true };
      return { status: 200, headers: {}, setCookie: [], body: 'OK' };
    });
    const r = defaultSyncFetch(req());
    __setWorkerSyncFetchForTest(null);
    assert.equal(calls, 2);
    assert.equal(r.status, 200);
    assert.equal(r.body, 'OK');
    const s = l1StatsSnapshot();
    assert.equal(s.curl.fallback + s.curl.blocked, 0);
  });
});

test('D2 ①：YUEDU_CURL_FALLBACK=1 才起 curl（人工开关）', async () => {
  await withEnv('YUEDU_CURL_FALLBACK', '1', () => {
    resetL1Stats();
    __setWorkerSyncFetchForTest(() => ({ status: 0, headers: {}, setCookie: [], body: '', yueduLinkFail: true }));
    // curl 在沙箱环境可能 spawn 失败，但**决策**必须已经记成 curl（用 diag 计数断言）
    defaultSyncFetch(req());
    __setWorkerSyncFetchForTest(null);
    const s = l1StatsSnapshot();
    assert.equal(s.curl.fallback, 1);
    assert.equal(s.curl.blocked, 0);
    assert.equal(s.curl.reasons['curl:worker-link-fail'], 1);
  });
});

test('D2 ①：环境不支持 worker ⇒ 默认空响应，不回落 curl', async () => {
  try {
    __setSyncFetchDisabledForTest(true);
    await withEnv('YUEDU_CURL_FALLBACK', undefined, () => {
      resetL1Stats();
      const r = defaultSyncFetch(req());
      assert.equal(r.status, 0);
      assert.equal(r.body, '');
      const s = l1StatsSnapshot();
      assert.equal(s.curl.blocked, 1);
      assert.equal(s.curl.fallback, 0);
      assert.equal(s.curl.reasons['blocked:worker-unavailable'], 1);
    });
  } finally {
    __setSyncFetchDisabledForTest(false);
  }
});

test('D2 ②：L1 单段到点中止 ⇒ L1_TIMEOUT（不是 JS_TIMEOUT）', async () => {
  await withEnv('YUEDU_L1_MAX_MS', '50', async () => {
    resetL1Stats();
    const ev = createJsEvaluator({
      variables: createVariableStore(),
      syncFetch: (): SyncHttpResponse => {
        blockFor(120);
        return { status: 200, headers: {}, setCookie: [], body: 'LATE' };
      },
    });
    let err: unknown = null;
    try {
      ev('java.ajax("http://slow.test/")', {});
    } catch (e) {
      err = e;
    }
    assert.ok(err, '到点必须中止（不能把 120ms 的请求当成功继续跑）');
    assert.ok(err instanceof L1EvalTimeoutError, `必须是 L1EvalTimeoutError，实际 ${String(err)}`);
    assert.equal((err as L1EvalTimeoutError).code, 'L1_TIMEOUT');
    assert.match((err as Error).message, /L1_TIMEOUT/);
    assert.doesNotMatch((err as Error).message, /JS_TIMEOUT/, '不能和 worker 的 JS_TIMEOUT 混在一起');
    const s = l1StatsSnapshot();
    assert.equal(s.timeout.n, 1);
    assert.ok(s.timeout.maxMs >= 100, `实际 ${s.timeout.maxMs}ms`);
    assert.equal(blockCounters().find((c) => c.kind === 'l1-timeout')?.n, 1, '阻塞计数器要有单独一类 l1-timeout');
  });
});

test('D2 ②：YUEDU_L1_MAX_MS=0 关闭硬超时（慢请求照常返回）', async () => {
  await withEnv('YUEDU_L1_MAX_MS', '0', async () => {
    resetL1Stats();
    const ev = createJsEvaluator({
      variables: createVariableStore(),
      syncFetch: (): SyncHttpResponse => {
        blockFor(60);
        return { status: 200, headers: {}, setCookie: [], body: 'SLOW-OK' };
      },
    });
    assert.equal(String(ev('java.ajax("http://slow.test/")', {})), 'SLOW-OK');
    assert.equal(l1StatsSnapshot().timeout.n, 0);
  });
});

test('D2 ③：diag 记录 l1w-drop（绑定名 + 次数）与 worker 落点', async () => {
  await withEnv('YUEDU_L1_WORKER', '1', async () => {
    resetL1Stats();
    const pool = createWorkerSandboxPool({ size: 1 });
    const ev = createHybridJsEvaluator({
      variables: createVariableStore(),
      pool,
      syncFetch: () => ({ status: 200, headers: {}, setCookie: [], body: '{"ok":1}' }),
      http: async () => ({ status: 200, headers: {}, body: '{"ok":1}' }),
    }) as Ev;
    const out = await Promise.resolve(
      ev('java.ajax("https://x.test/pure")', {
        result: { text: () => 'dom' },
        $: { select: () => [] },
        src: { outerHTML: '<div/>' },
      }),
    );
    assert.equal(String(out), '{"ok":1}');
    const s = l1StatsSnapshot();
    assert.equal(s.eligible, 1);
    assert.equal(s.routed.worker, 1);
    assert.equal(s.routed.l1, 0);
    // `src` 先被 `#629` 按需下发（脚本未引用 ⇒ 已删），真正进入 l1w-drop 的是 `$` / `result`
    assert.equal(s.drops.count, 2);
    assert.deepEqual(s.drops.bindings, { result: 1, $: 1 });
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });
});

test('D2 ③：默认关时只记 `switch-off`，不把判据失败算进去', async () => {
  await withEnv('YUEDU_L1_WORKER', undefined, async () => {
    resetL1Stats();
    const ev = createHybridJsEvaluator({
      variables: createVariableStore(),
      pool: createWorkerSandboxPool({ size: 1 }),
      syncFetch: () => ({ status: 200, headers: {}, setCookie: [], body: '{"ok":1}' }),
    }) as Ev;
    const out = await Promise.resolve(ev('java.ajax("https://x.test/pure")', { result: { text: () => 'dom' } }));
    assert.equal(String(out), '{"ok":1}');
    const s = l1StatsSnapshot();
    assert.equal(s.eligible, 0);
    assert.equal(s.routed.l1, 1);
    assert.equal(s.reasons['switch-off'], 1);
  });
});

test('D2 ③：reset 清零（配合 /api/diag?reset=1 的单窗口基线）', () => {
  resetL1Stats();
  const s = l1StatsSnapshot();
  assert.deepEqual(s.routed, { worker: 0, l1: 0 });
  assert.equal(s.eligible, 0);
  assert.deepEqual(s.reasons, {});
  assert.deepEqual(s.curl.reasons, {});
  assert.equal(s.timeout.n, 0);
});
