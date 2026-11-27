/**
 * `#699` 回归锁：**信息流里的重定向回执要带真实状态码，且排在 `≡获取成功` 之前**。
 *
 * ## 上游出处
 * `F:\legado\app\src\main\java\io\legado\app\model\webBook\WebBook.kt:579-588`（书源）
 * 与 `app\src\main\java\io\legado\app\model\rss\Rss.kt:246-254`（订阅源）是**同一段**：
 * ```kotlin
 * private fun checkRedirect(response: StrResponse) {
 *     response.raw.priorResponse?.let {
 *         if (it.isRedirect) {
 *             Debug.log("≡检测到重定向(${it.code})")
 *             Debug.log("┌重定向后地址")
 *             Debug.log("└${response.url}")
 *         }
 *     }
 * }
 * ```
 * 调用点在 `≡获取成功:` **紧前面**（`Rss.kt:82-83`）。
 *
 * ## 我们此前为什么做不到
 * `fetch(url, {redirect:'follow'})` 只把**最终**响应交回来 —— 3xx 码与 `Location` 全被 undici
 * 吞掉，`HttpResponse` 里连一条「曾经跳过」的记录都没有。旧实现只能打一句
 * 「请求地址≠落地地址，3xx 码底层 fetch 不透出」——用户要的就是那个数字。
 *
 * ## 现在
 * 网络层自己跟链（`core/net/index.ts` 的 `fetchOnceInner`），`HttpResponse.redirects` 是
 * `{status,url,location,target}[]`。本测试锁三件事：
 *  1. 每跳一对 `≡检测到重定向(N)` + `┌重定向后地址` + `└<target>`；
 *  2. 顺序在 `≡获取成功` **之前**（与上游一致）；
 *  3. 多跳时按发生顺序、每条带自己的目标（301 与 302 必须分得出来）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createMemoryKeyValueStore,
  createTraceSink,
  createVariableStore,
  type EngineContext,
  type HttpClient,
  type HttpResponse,
  type JsSandboxPool,
} from '@yuedu/core';

import { LegadoEngine } from '../index';

const noopSandbox: JsSandboxPool = {
  async eval() {
    throw new Error('no sandbox');
  },
};

const LIST_HTML = `<html><body><ul class="list">
  <li><h3><a href="/b/1">书A</a></h3><span class="author">甲</span></li>
</ul></body></html>`;

const RAW = {
  bookSourceUrl: 'https://old.test',
  bookSourceName: '重定向测试源',
  /** 上游 `BookSource.searchUrl`（顶层字段）：`{{key}}` = 关键词 */
  searchUrl: '/s?k={{key}}',
  ruleSearch: { bookList: '.list > li', name: 'h3 > a@text', bookUrl: 'h3 > a@href', author: '.author@text' },
};

function makeCtx(http: HttpClient): EngineContext {
  return {
    reqId: 'r699',
    sourceId: 'src',
    signal: new AbortController().signal,
    http,
    sandbox: noopSandbox,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

/** 把 trace 里带 msg 的条目取出来（顺序即发生顺序） */
function msgs(ctx: EngineContext): string[] {
  return ctx.trace
    .all()
    .map((e) => (e as { msg?: string }).msg)
    .filter((m): m is string => typeof m === 'string');
}

const engine = new LegadoEngine();
const rule = (() => {
  const r = engine.compile(RAW);
  assert.ok(r.ok && r.rule, 'compile 应通过');
  return r.rule!;
})();

test('#699 ① 单跳 301：打「≡检测到重定向(301) / ┌重定向后地址 / └目标」，且在「≡获取成功」之前', async () => {
  const http: HttpClient = {
    async request(url: string): Promise<HttpResponse> {
      assert.equal(url, 'https://old.test/s?k=x', '请求打到源里那个地址');
      return {
        status: 200,
        headers: {},
        body: LIST_HTML,
        url: 'https://new.test/s?k=x',
        redirects: [
          { status: 301, url: 'https://old.test/s?k=x', location: 'https://new.test/s?k=x', target: 'https://new.test/s?k=x' },
        ],
      };
    },
  };
  const ctx = makeCtx(http);
  const r = await engine.search(rule, { action: 'search', keyword: 'x', page: 1 }, ctx);
  assert.equal(r.items.length, 1, '重定向不应影响解析');

  const all = msgs(ctx);
  const iHop = all.indexOf('≡检测到重定向(301)');
  const iTitle = all.indexOf('┌重定向后地址');
  const iTarget = all.indexOf('└https://new.test/s?k=x');
  const iOk = all.findIndex((m) => m.startsWith('≡获取成功:'));
  assert.ok(iHop >= 0, `缺少「≡检测到重定向(301)」，实际：${all.join(' | ')}`);
  assert.equal(iTitle, iHop + 1, '┌重定向后地址 必须紧跟状态码行');
  assert.equal(iTarget, iTitle + 1, '└目标 必须紧跟标题行');
  assert.ok(iOk > iTarget, '重定向回执必须排在「≡获取成功」之前（上游 Rss.kt:82-83 同序）');
  assert.ok(
    all.some((m) => m === '≡获取成功:https://new.test/s?k=x'),
    '获取成功打的是**落地地址**',
  );
  assert.ok(!all.some((m) => /未提供 3xx 码/.test(m)), '有跳跃链时不该再打兜底那句');
});

test('#699 ② 多跳：按发生顺序，301 与 302 分得出来', async () => {
  const http: HttpClient = {
    async request(url: string): Promise<HttpResponse> {
      return {
        status: 200,
        headers: {},
        body: LIST_HTML,
        url: 'https://c.test/final',
        redirects: [
          { status: 302, url, location: 'https://b.test/mid', target: 'https://b.test/mid' },
          { status: 301, url: 'https://b.test/mid', location: '/final', target: 'https://c.test/final' },
        ],
      };
    },
  };
  const ctx = makeCtx(http);
  await engine.search(rule, { action: 'search', keyword: 'x', page: 1 }, ctx);
  const all = msgs(ctx);
  /**
   * 按「三元组」抽：每遇到 `≡检测到重定向` 就取它后面两行 —— 不能直接过滤 `└https://`，
   * 列表解析自己也会打 `└<详情页链接>`（会把断言带偏，本测试第一版就是这么误报的）。
   */
  const triples: string[] = [];
  for (let i = 0; i < all.length; i++) {
    if (all[i]!.startsWith('≡检测到重定向')) triples.push(all.slice(i, i + 3).join(' ⏎ '));
  }
  assert.deepEqual(
    triples,
    [
      '≡检测到重定向(302) ⏎ ┌重定向后地址 ⏎ └https://b.test/mid',
      '≡检测到重定向(301) ⏎ ┌重定向后地址 ⏎ └https://c.test/final',
    ],
    `顺序即发生顺序、每条带自己的目标：${all.join(' | ')}`,
  );
});

test('#699 ③ 没有重定向 ⇒ 一条都不打（不制造噪声）', async () => {
  const http: HttpClient = {
    async request(url: string): Promise<HttpResponse> {
      return { status: 200, headers: {}, body: LIST_HTML, url };
    },
  };
  const ctx = makeCtx(http);
  await engine.search(rule, { action: 'search', keyword: 'x', page: 1 }, ctx);
  const all = msgs(ctx);
  assert.ok(!all.some((m) => /检测到重定向/.test(m)), all.join(' | '));
  assert.ok(all.some((m) => m.startsWith('≡获取成功:')), '正常路径该有的回执不能少');
});

test('#699 ④ 落地地址变了却没有跳跃链（非标准通路）⇒ 如实说「未提供 3xx 码」，不编数字', async () => {
  const http: HttpClient = {
    async request(): Promise<HttpResponse> {
      return { status: 200, headers: {}, body: LIST_HTML, url: 'https://new.test/s?k=x' };
    },
  };
  const ctx = makeCtx(http);
  await engine.search(rule, { action: 'search', keyword: 'x', page: 1 }, ctx);
  const all = msgs(ctx);
  assert.ok(all.includes('≡检测到重定向（该通路未提供 3xx 码）'), all.join(' | '));
  assert.ok(!all.some((m) => /\(\d{3}\)/.test(m)), '不许编造状态码');
});
