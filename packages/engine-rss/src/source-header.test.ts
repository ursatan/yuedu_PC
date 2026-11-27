/**
 * `#464` 源 `header` 的**脚本形态**（`@js:` / `<js>`）回归锁 —— RSS 引擎侧的 403 缺陷。
 *
 * ## 缺陷（用户 2026-10-15 实测 ˃̶͈ ꇴ ˂̶͈）
 * 正文页 `http://gedem.uaa.cn.mt/work/syfby.php` 报 `NETWORK@request · 正文页 HTTP 403`，
 * 而 App（Legado）能正常打开。curl 对照：**带 `Authorization: Bearer <token>` → 200/46KB**、
 * 不带 → 403「访问被拒绝」。而该源的 `header` 正是 `@js:` 型（求值出 Authorization）。
 *
 * 本引擎此前只有 `parseSourceHeaders`（**纯 JSON** 形态）⇒ `@js:` 头被整条丢掉 ⇒ 恒 403。
 * `engine-legado` 早有这条（`ajax-source-headers.test.ts` 锁着「`@js:` 形态求值后成为请求头」），
 * RSS 侧漏了 —— 同一判据写两处必然漂移（`#247`）。
 *
 * ★ 覆盖三条：①`@js:` 求值成为请求头；②纯 JSON 形态不受影响；③求值失败**不阻断**请求（降级空头）。
 * 另外锁住「每请求只求值一次」（memo 在 `ctx.variables`）—— 否则同一请求会重复跑脚本
 * （本批语料的 header 里 `getUrl()` 会弹 toast 并同步 sleep ⇒ 重复求值 = toast 刷屏 + 卡顿）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTraceSink, createVariableStore, type EngineContext } from '@yuedu/core';

import { makeRssEnv, parseHeaderRule, sourceHeadersFromCtx, whenSourceHeadersPrimed } from './env';
import { compileRssSource, type RssSourceRaw } from './model/rss-source';

function makeCtx(): EngineContext {
  return {
    reqId: 't',
    sourceId: 'fake.test',
    signal: new AbortController().signal,
    http: { async request() { return { status: 200, headers: {}, body: '', url: '' }; } },
    sandbox: { async eval<T = unknown>() { return undefined as T; } },
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: { async get() { return null; }, async set() {}, async delete() {} },
    toastSink: [],
  } as unknown as EngineContext;
}

/** 语料的极简复现：请求头里的值来自 **jsLib 里的函数**（这正是脚本型 header 的意义） */
const JS_HEADER = `@js:\nlet u=getUrl();\nJSON.stringify({ 'User-Agent': java.getWebViewUA(), 'Authorization': "Bearer "+token })`;

const jsRule = compileRssSource({
  sourceUrl: 'https://gedem.demo',
  sourceName: '脚本头源',
  header: JS_HEADER,
  jsLib: 'var token="TK123";\nfunction getUrl(){return "gedem"}',
} as RssSourceRaw);

test('① `@js:` 形态的 source header 求值后成为请求头（分隔线：旧实现这里恒空）', async () => {
  const ctx = makeCtx();
  const env = makeRssEnv(ctx, jsRule, jsRule.sourceUrl);
  void env;
  // `#463①`：makeRssEnv 改为**异步 prime**（worker 池）；请求出口 await 后读 memo
  await whenSourceHeadersPrimed(ctx);
  const h = sourceHeadersFromCtx(ctx, jsRule);
  assert.equal(h['Authorization'], 'Bearer TK123', 'jsLib 里的 token 必须参与求值');
  assert.ok(String(h['User-Agent'] ?? '').length > 0, 'java.getWebViewUA() 必须有值');
});

test('② 纯 JSON 形态不受影响（与旧行为逐字一致）', async () => {
  const jsonRule = compileRssSource({
    sourceUrl: 'https://json.demo',
    sourceName: 'JSON头源',
    header: '{"X-From-Rule":"yes-json"}',
  } as RssSourceRaw);
  const ctx = makeCtx();
  makeRssEnv(ctx, jsonRule, jsonRule.sourceUrl);
  await whenSourceHeadersPrimed(ctx);
  assert.equal(sourceHeadersFromCtx(ctx, jsonRule)['X-From-Rule'], 'yes-json');
});

test('③ header 脚本求值失败 ⇒ 降级空头，**不抛**（与上游 runCatching 同义）', () => {
  let calls = 0;
  const out = parseHeaderRule(jsRule, () => {
    calls += 1;
    throw new Error('boom');
  });
  assert.deepEqual(out, {});
  assert.equal(calls, 1);
});

test('④ 每请求只求值一次（memo 在 ctx.variables）—— 防重复 toast / 同步 sleep', async () => {
  const ctx = makeCtx();
  makeRssEnv(ctx, jsRule, jsRule.sourceUrl);
  await whenSourceHeadersPrimed(ctx);
  const first = sourceHeadersFromCtx(ctx, jsRule);
  // 命中 memo ⇒ 两次一致且不再跑脚本
  const second = sourceHeadersFromCtx(ctx, jsRule);
  assert.equal(first['Authorization'], second['Authorization']);
  assert.equal(typeof ctx.variables.get('__srcHeaders'), 'string', '解析结果必须落在 ctx.variables 供各请求出口复用');
});

test('⑤ 头里 `source.getVariable()` 取到源变量（脚本型 header 的实际用法）', async () => {
  const rule = compileRssSource({
    sourceUrl: 'https://var.demo',
    sourceName: '变量头源',
    header: '@js:JSON.stringify({"X-Tag": String(source.getVariable() || "默认")})',
  } as RssSourceRaw);
  const ctx = makeCtx();
  ctx.variables.set('sourceVariable', '美丽');
  makeRssEnv(ctx, rule, rule.sourceUrl);
  await whenSourceHeadersPrimed(ctx);
  assert.equal(sourceHeadersFromCtx(ctx, rule)['X-Tag'], '美丽');
});
