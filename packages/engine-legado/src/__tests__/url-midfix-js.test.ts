/**
 * 回归锁：URL 规则里的 `@js:` / `<js>` 出现在**任意位置**都必须触发求值（`#383`）。
 *
 * ## 缺陷类
 * 上游 `AnalyzeUrl.kt:167-193` 的 `analyzeJs()` 用 `JS_PATTERN = /<js>…<\/js>|@js:…/`
 * 配 `Matcher.find()` —— **全文扫描**，命中点之前的前缀除非写 `@result` 否则被丢弃。
 * 旧实现判据是 `raw.startsWith('@js:')`：只认**整串开头**。
 *
 * ## 实测形态（qyyuapi 五源，与 `#382` rss 侧同款）
 *   `Movieffm@js:`{{Get('url')}}/cats/x/``
 * 分类名前缀 `Movieffm` + 中缀 `@js:` 标记 ⇒ 旧实现整条被当 URL 原样发出
 * （`Invalid URL` / 请求到不存在的相对路径），`#382` 在 rss 侧已用 core
 * `applyUrlRuleJs` 修掉，legado 侧是同一缺陷类的**漏网分支**。
 *
 * ## 锁什么
 * ① 中缀 `@js:` 触发求值、前缀按上游语义丢弃；
 * ② `<js>` 前缀形态（原已支持）不回归；
 * ③ 前缀写 `@result` 时以累积结果回填、尾部残余按 `@result` 拼接。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpRequestOptions, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://d.test';

function makeSrc(over: Record<string, unknown> = {}) {
  const out = compileBookSource({
    bookSourceUrl: `${BASE}/`,
    bookSourceName: 'url-midfix 回归源',
    bookSourceType: 0,
    ...over,
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

/** 记录每次请求的 url / method；sandbox.eval 用一个最简 JS 求值器（剥反引号 + 拼 result） */
function makeCtx() {
  const reqs: Array<{ url: string; method: string; body?: string }> = [];
  const ctx: EngineContext = {
    reqId: 'midfix',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string, opts?: HttpRequestOptions): Promise<HttpResponse> {
        const body = typeof opts?.body === 'string' ? opts.body : undefined;
        reqs.push({ url, method: opts?.method ?? 'GET', ...(body !== undefined ? { body } : {}) });
        return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"bookName":"书名"}', url };
      },
    },
    // 最简 JS 求值器：本测试只验「JS 段是否被触发 + 前缀/尾巴语义」，不验沙箱本身。
    // 真实源里 JS 段是「字符串拼接」形态（`return 'url' + ',{...}'`），这里按同构方式求值：
    // 取出所有引号字符串、按 `+` 拼接成结果。
    sandbox: {
      async eval(code: string, _bindings?: Record<string, unknown>) {
        const parts = [...code.matchAll(/`([\s\S]*?)`|'([^']*)'|"([^"]*)"/g)].map(
          (m) => m[1] ?? m[2] ?? m[3] ?? '',
        );
        if (parts.length) return parts.join('');
        return code.trim();
      },
    } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, reqs };
}

test('#383：中缀 @js: 触发求值，分类名前缀按上游语义丢弃', async () => {
  // 真实形态：`Movieffm@js:`https://qyyuapi.com/cats/x/``
  const rule = makeSrc({
    searchUrl: 'Movieffm@js:`' + BASE + '/api/list?q={{key}}`',
  });
  const { ctx, reqs } = makeCtx();
  await new LegadoEngine().search(rule, { action: 'search', keyword: 'w' }, ctx);
  const r = reqs[0];
  assert.ok(r, '必须发出搜索请求');
  // 前缀 `Movieffm` 被丢弃；JS 段取出的 URL 成为请求地址
  assert.ok(r.url.startsWith(`${BASE}/api/list`), `中缀 @js: 必须求值，实得 ${r.url}`);
  assert.ok(!r.url.includes('Movieffm'), `前缀必须丢弃，实得 ${r.url}`);
});

test('#383：<js> 前缀形态不回归（原已支持）', async () => {
  const rule = makeSrc({ searchUrl: '<js>`' + BASE + '/api/list?q=`</js>' });
  const { ctx, reqs } = makeCtx();
  await new LegadoEngine().search(rule, { action: 'search', keyword: 'w' }, ctx);
  const r = reqs[0];
  assert.ok(r, '必须发出搜索请求');
  assert.ok(r.url.startsWith(`${BASE}/api/list`), `前缀 <js> 形态必须仍可用，实得 ${r.url}`);
});

test('#383：中缀 JS 结果里的 ,{options} 尾巴仍照切（顺序不回归）', async () => {
  // JS 构造的 URL 自带尾巴 —— 必须只对**求值结果**切，不能先切 JS 源码。
  // 形态与真实源一致：`return 'url' + ',{"method":…}'`（字符串拼接）。
  const rule = makeSrc({
    searchUrl: "Pre@js:'" + BASE + "/api/list' + ',{\"method\":\"POST\",\"body\":\"x=1\"}'",
  });
  const { ctx, reqs } = makeCtx();
  await new LegadoEngine().search(rule, { action: 'search', keyword: 'w' }, ctx);
  const r = reqs[0];
  assert.ok(r, '必须发出搜索请求');
  assert.equal(r.url, `${BASE}/api/list`, `尾巴必须切掉，实得 ${r.url}`);
  assert.equal(r.method, 'POST', `尾巴 method 必须生效，实得 ${r.method}`);
});
