/**
 * 回归锁：**请求重试语义**与**行动预算**必须对齐 Legado（类别性缺陷，面向所有源）。
 *
 * 两个真因（均由 557 源基线 + 单并发复跑实测确认）：
 *
 * ① `retry` 完全反了
 *    Legado `OkHttpUtils.kt:29-44 newCallResponse`：
 *      · 次数 = `UrlOption.retry`，**默认 0**（`AnalyzeUrl.kt:121 retry = 0`）；
 *      · **只在响应非 2xx/3xx 时**才重试；
 *      · 网络异常（`await()` 抛 IOException）**直接抛出，不重试**。
 *    旧实现恰好相反：网络异常无条件重试一次、HTTP 错误状态从不重试。
 *    后果是**单请求最坏 25s×2 = 50s**，超过任何客户端预算 → 客户端先超时退出、服务端还在跑
 *    （基线里 68 处网络 TIMEOUT 的耗时精确落在客户端预算边界上，就是这个形态）。
 *    语料 484 源中 `retry` 使用 **0 处** —— 所有源都应走默认 0 次。
 *
 * ② 行动预算（`EngineHub.timeoutMs`）是**死字段**
 *    它只被写进 `ctx.signal`，而**没有任何地方消费 signal** → 一次行动可以无限跑；
 *    服务端因此无法在自己的预算内结束并如实报错。
 *    修法：`ctx.deadlineAt`（绝对截止时刻），每个请求超时 = min(60s, 剩余预算)。
 *
 * ③ 单请求预算对齐 Legado：**callTimeout 60s**（`HttpHelper.kt:59-62`）
 *    post3 基线实测：25s 上限太紧 —— retry 归零后慢站没有第二次窗口，
 *    search 308→291、TIMEOUT 71→90，形态全是「25s 整点请求超时」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpRequestOptions, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://retry.test';

function makeSrc(over: Record<string, unknown> = {}) {
  const out = compileBookSource({
    bookSourceUrl: `${BASE}/`,
    bookSourceName: '重试语义回归源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'bookName' },
    ...over,
  });
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);
  return out.rule!;
}

/** 可控 HTTP 桩：记录每次请求，按 `respond` 决定返回或抛错 */
function makeCtx(opts: {
  respond?: (n: number) => HttpResponse | Error;
  deadlineAt?: number;
} = {}) {
  const reqs: Array<{ url: string; method: string; timeout?: number }> = [];
  const ctx: EngineContext = {
    reqId: 'retry',
    sourceId: 'test',
    signal: new AbortController().signal,
    ...(opts.deadlineAt ? { deadlineAt: opts.deadlineAt } : {}),
    http: {
      async request(url: string, o?: HttpRequestOptions): Promise<HttpResponse> {
        reqs.push({ url, method: o?.method ?? 'GET', ...(o?.timeout ? { timeout: o.timeout } : {}) });
        const r = opts.respond?.(reqs.length);
        if (r instanceof Error) throw r;
        return r ?? { status: 200, headers: {}, body: 'ok', url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, reqs };
}

const DETAIL_OK = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"bookName":"书名"}' };

test('① 默认 retry=0：HTTP 500 不得重试（旧实现会无条件重试，单请求最坏翻倍）', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx({ respond: () => ({ status: 500, headers: {}, body: 'boom', url: `${BASE}/api/1` }) });
  await new LegadoEngine().detail(rule, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/1` }) }, ctx);
  assert.equal(reqs.length, 1, `retry 默认 0 → 只允许 1 次请求，实际 ${reqs.length}`);
});

test('①b UrlOption.retry=2：HTTP 500 必须重试到 3 次（Legado newCallResponse 语义）', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx({ respond: () => ({ status: 503, headers: {}, body: 'busy', url: `${BASE}/api/2` }) });
  await new LegadoEngine().detail(
    rule,
    { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/2,{"retry":2}` }) },
    ctx,
  );
  assert.equal(reqs.length, 3, `retry=2 → 首次 + 2 次重试 = 3，实际 ${reqs.length}`);
});

test('①c 2xx 不触发重试（即便 retry>0）', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx({ respond: () => ({ ...DETAIL_OK, url: `${BASE}/api/3` }) });
  await new LegadoEngine().detail(
    rule,
    { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/3,{"retry":5}` }) },
    ctx,
  );
  assert.equal(reqs.length, 1, `成功响应不得重试，实际 ${reqs.length}`);
});

test('①d 网络异常**不重试**，且必须归因成 NETWORK（不得报成 RULE_PARSE）', async () => {
  const rule = makeSrc();
  const err = Object.assign(new Error('DNS 解析失败（域名可能已失效）'), { code: 'NETWORK' });
  const { ctx, reqs } = makeCtx({ respond: () => err });
  const thrown = await new LegadoEngine()
    .detail(rule, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/4` }) }, ctx)
    .then(() => undefined)
    .catch((e: unknown) => e as { message?: string; detail?: { input?: string } });
  assert.ok(thrown, '网络异常必须抛出（不得被静默吞掉）');
  // 归因必须是网络：`core/src/net/index.ts` 的 describeNetworkError 文案 + code='NETWORK'
  // 曾经的 bug：isNetworkError 只扫 cause.code 与英文 errno 正则 → 我们自己的中文文案一条不匹配
  // → 归成 `RULE_PARSE@parse`（把网络问题说成解析问题）。
  assert.match(String(thrown.message), /NETWORK/, `必须归因成 NETWORK：${String(thrown.message)}`);
  assert.match(String(thrown.detail?.input ?? ''), /DNS 解析失败/, `必须保留可读原因：${JSON.stringify(thrown.detail)}`);
  assert.equal(reqs.length, 1, `网络异常不得重试，实际 ${reqs.length}`);
});

test('② 行动预算：请求超时不得超过剩余预算（deadlineAt）', async () => {
  const rule = makeSrc();
  const deadlineAt = Date.now() + 4_000;
  const { ctx, reqs } = makeCtx({ respond: () => ({ ...DETAIL_OK, url: `${BASE}/api/5` }), deadlineAt });
  await new LegadoEngine().detail(rule, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/5` }) }, ctx);
  const t = reqs[0]?.timeout ?? 0;
  assert.ok(t > 3_000 && t <= 4_000, `超时应压进剩余预算（约 4s），实际 ${t}ms`);
});

test('②b 无 deadlineAt 时用 60s 上限（Legado callTimeout，HttpHelper.kt:62）', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx({ respond: () => ({ ...DETAIL_OK, url: `${BASE}/api/6` }) });
  await new LegadoEngine().detail(rule, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/6` }) }, ctx);
  assert.equal(reqs[0]?.timeout, 60_000, `缺省应为 60s（Legado callTimeout），实际 ${reqs[0]?.timeout}`);
});

test('②c 预算已用尽时保底 1s（不得算出 0/负数让请求必然失败）', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx({ respond: () => ({ ...DETAIL_OK, url: `${BASE}/api/7` }), deadlineAt: Date.now() - 10_000 });
  await new LegadoEngine().detail(rule, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/7` }) }, ctx);
  assert.equal(reqs[0]?.timeout, 1_000, `应保底 1000ms，实际 ${reqs[0]?.timeout}`);
});

/**
 * ②d 源选项 `timeout`（毫秒）→ Legado 落到 **readTimeout**（AnalyzeUrl.kt:268-271），
 *    并派生 `callTimeout = max(60s, read×2)`（AnalyzeUrlNetworkOptions.kt:77-84）。
 *    我们只有一个「整请求超时」（= callTimeout 语义），故取派生值。
 *    语料 484 源用 0 处（潜在字段，#84）：既不能漏消费，也不能因它把默认预算改小。
 */
test('②d UrlOption.timeout=1500 → callTimeout 取派生值 max(60s, 1.5s×2) = 60s（不得缩到 3s）', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx({ respond: () => ({ ...DETAIL_OK, url: `${BASE}/api/8` }) });
  await new LegadoEngine().detail(
    rule,
    { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/8,{"timeout":1500}` }) },
    ctx,
  );
  assert.equal(reqs[0]?.timeout, 60_000, `派生下限是 60s，实际 ${reqs[0]?.timeout}`);
});

test('②e UrlOption.timeout=90000 → callTimeout = 90000×2 = 180s（显式放宽必须生效）', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx({ respond: () => ({ ...DETAIL_OK, url: `${BASE}/api/9` }) });
  await new LegadoEngine().detail(
    rule,
    { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/9,{"timeout":90000}` }) },
    ctx,
  );
  assert.equal(reqs[0]?.timeout, 180_000, `应为 read×2，实际 ${reqs[0]?.timeout}`);
});

test('②f 非法 timeout（0 / 负数 / 非数字）被忽略，回落 60s（parseRequestTimeoutMillis 只认 1..Int.MAX）', async () => {
  for (const bad of ['0', '-5', '"abc"']) {
    const rule = makeSrc();
    const { ctx, reqs } = makeCtx({ respond: () => ({ ...DETAIL_OK, url: `${BASE}/api/10` }) });
    await new LegadoEngine().detail(
      rule,
      { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/10,{"timeout":${bad}}` }) },
      ctx,
    );
    assert.equal(reqs[0]?.timeout, 60_000, `timeout=${bad} 应被忽略 → 60s，实际 ${reqs[0]?.timeout}`);
  }
});
