/**
 * `#579` 发现页/搜索两条入口的 URL 判据（用户实测故障）：
 *  · 📚聚合书库：`exploreUrl` 脚本用 `java.connect(baseUrl, header)`，bindings 缺 `baseUrl`
 *    ⇒ `Malformed URL:` ⇒ 分类只有一条 ERROR；
 *  · 📥苦瓜书盘：分类 URL 用 `<,index_1.html>` 页码模式 ⇒ 真跑未替换 ⇒ `%3C,…%3E` ⇒ 404
 *    ⇒「该分类没有内容」，而规则工坊（`evalUrlTemplate` 实现了该模式）试跑全通。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createMemoryKeyValueStore, createTraceSink, createVariableStore } from '@yuedu/core';

const BASE = 'https://kg.test';

function makeCtx(respond: (url: string) => HttpResponse | Error) {
  const reqs: string[] = [];
  const ctx: EngineContext = {
    reqId: 'explore-url-579',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        reqs.push(url);
        const r = respond(url);
        if (r instanceof Error) throw r;
        return r;
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, reqs } as const;
}

test('#579 home：exploreUrl 脚本能读到 baseUrl（不再 Malformed URL）', async () => {
  const compiled = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: 'baseUrl 绑定回归源',
    bookSourceType: 0,
    exploreUrl: '@js: [{ title: "全部", url: baseUrl + "/list" }]',
    ruleExplore: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
  });
  assert.ok(compiled.ok && compiled.rule, `compile 失败：${JSON.stringify(compiled.issues)}`);
  const { ctx } = makeCtx(() => ({ status: 200, headers: {}, body: '<div class="item"><a href="/b/1">x</a></div>', url: BASE }));
  const out = await new LegadoEngine().home(compiled.rule!, { action: 'home' }, ctx);
  const opts = out.filters?.[0]?.options ?? [];
  assert.equal(opts[0]?.value, `${BASE}/list`, `baseUrl 绑定缺失：${JSON.stringify(opts)}`);
});

test('#579 search：`<,index_1.html>` 必须在绝对化前替换（否则 %3C 404）', async () => {
  const compiled = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '页码模式回归源',
    bookSourceType: 0,
    searchUrl: '/search/<,index_1.html>?q={{key}}',
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
  });
  assert.ok(compiled.ok && compiled.rule, `compile 失败：${JSON.stringify(compiled.issues)}`);
  const { ctx, reqs } = makeCtx(() => ({ status: 200, headers: {}, body: '<div class="item"><a href="/b/1">x</a></div>', url: BASE }));
  await new LegadoEngine().search(compiled.rule!, { action: 'search', keyword: 'k', page: 1 }, ctx);
  assert.equal(reqs[0], `${BASE}/search/?q=k`, `页码模式未替换：${reqs[0]}`);

  const second = makeCtx(() => ({ status: 200, headers: {}, body: '<div class="item"><a href="/b/1">x</a></div>', url: BASE }));
  await new LegadoEngine().search(compiled.rule!, { action: 'search', keyword: 'k', page: 2 }, second.ctx);
  assert.equal(second.reqs[0], `${BASE}/search/index_1.html?q=k`, `第 2 页应取 index_1：${second.reqs[0]}`);
});
