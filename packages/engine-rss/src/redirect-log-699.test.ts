/**
 * `#699` 订阅源侧的重定向回执（对齐上游 `Rss.kt:246-254` 的 `checkRedirect`）。
 *
 * ## 上游形制
 * ```kotlin
 * // Rss.kt:82-83（列表）
 * checkRedirect(rssSource, res)
 * Debug.log("≡获取成功:${analyzeUrl.ruleUrl}")     // ← 规则 URL（可能是相对路径）
 *
 * // Rss.kt:211（内容页）
 * checkRedirect(...)
 * Debug.log("≡获取成功:${res.url}")               // ← 落地地址（跟随重定向后）
 * ```
 * 两处 `≡获取成功` 的口径**不同**，这是源码本来的写法，不是笔误。
 *
 * ## 本测试锁什么
 * 1. 列表：三行回执（状态码 / 标题 / 目标）排在 `≡获取成功:<规则URL>` 之前；
 * 2. 内容页：`≡获取成功` 打的是**落地地址**（旧实现打的是重定向前那个 URL，
 *    重定向站点会变成「获取成功:<旧域名>」的怪象）；
 * 3. 没有重定向 ⇒ 不制造噪声。
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
  type UnifiedRequest,
} from '@yuedu/core';

import { RssEngine } from './engine';
import type { RssSourceRaw } from './model/rss-source';

const noopSandbox: JsSandboxPool = {
  async eval() {
    throw new Error('no sandbox');
  },
};

const LIST_HTML = `<html><body><ul>
  <li class="item"><a href="/a/1.html">文章一</a><span class="t">2026-10-31</span></li>
</ul></body></html>`;

function makeCtx(http: HttpClient): EngineContext {
  return {
    reqId: 'rss699',
    sourceId: 'rss',
    signal: new AbortController().signal,
    http,
    sandbox: noopSandbox,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  } as EngineContext;
}

function msgs(ctx: EngineContext): string[] {
  return ctx.trace
    .all()
    .map((e) => (e as { msg?: string }).msg)
    .filter((m): m is string => typeof m === 'string');
}

const engine = new RssEngine();
const RAW: RssSourceRaw = {
  sourceUrl: 'https://old.rss.test',
  sourceName: '重定向订阅源',
  searchUrl: '/search?q={{key}}',
  ruleArticles: 'ul > li.item',
  ruleTitle: 'a@text',
  ruleLink: 'a@href',
  rulePubDate: '.t@text',
  /** 内容页规则（不加它 `content()` 报 `UNSUPPORTED_ACTION`：源被当成 webView 型阅读） */
  ruleContent: '.c@text',
} as RssSourceRaw;

const rule = (() => {
  const r = engine.compile(RAW);
  assert.ok(r.ok && r.rule, 'compile 应通过');
  return r.rule!;
})();

test('#699 RSS① 列表：三行重定向回执排在「≡获取成功:<规则URL>」之前', async () => {
  const http: HttpClient = {
    async request(url: string): Promise<HttpResponse> {
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: LIST_HTML,
        url: 'https://new.rss.test/search?q=x',
        redirects: [
          {
            status: 301,
            url,
            location: 'https://new.rss.test/search?q=x',
            target: 'https://new.rss.test/search?q=x',
          },
        ],
      };
    },
  };
  const ctx = makeCtx(http);
  const r = await engine.search(rule, { action: 'search', keyword: 'x', page: 1 } as UnifiedRequest, ctx);
  assert.equal(r.items.length, 1, `列表应解析出 1 条：${JSON.stringify(r.items.map((i) => i.title))}`);

  const all = msgs(ctx);
  const iHop = all.indexOf('≡检测到重定向(301)');
  const iTitle = all.indexOf('┌重定向后地址');
  const iTarget = all.indexOf('└https://new.rss.test/search?q=x');
  const iOk = all.findIndex((m) => m.startsWith('≡获取成功:'));
  assert.ok(iHop >= 0, `缺少重定向回执：${all.join(' | ')}`);
  assert.equal(iTitle, iHop + 1);
  assert.equal(iTarget, iTitle + 1);
  assert.ok(iOk > iTarget, '重定向回执必须在「≡获取成功」之前（Rss.kt:82-83）');
  // 列表面的 `≡获取成功` 打**规则 URL**（上游 `analyzeUrl.ruleUrl`，相对路径就是相对路径）
  assert.equal(all[iOk], '≡获取成功:/search?q=x', `列表打规则 URL：${all[iOk]}`);
});

test('#699 RSS② 内容页：「≡获取成功」打的是落地地址（不是重定向前那个）', async () => {
  const http: HttpClient = {
    async request(url: string): Promise<HttpResponse> {
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html><body><div class="c">正文内容</div></body></html>',
        url: 'https://new.rss.test/a/1.html',
        redirects: [
          {
            status: 302,
            url,
            location: 'https://new.rss.test/a/1.html',
            target: 'https://new.rss.test/a/1.html',
          },
        ],
      };
    },
  };
  const ctx = makeCtx(http);
  const out = await engine.content(
    rule,
    { action: 'content', id: JSON.stringify({ link: 'https://old.rss.test/a/1.html' }), extra: {} } as UnifiedRequest,
    ctx,
  );
  assert.ok((out.html ?? '').length > 0, '正文应取到 HTML');

  const all = msgs(ctx);
  assert.ok(all.includes('≡检测到重定向(302)'), all.join(' | '));
  assert.ok(
    all.includes('≡获取成功:https://new.rss.test/a/1.html'),
    `内容页的「获取成功」必须是落地地址：${all.filter((m) => m.startsWith('≡获取成功')).join(' | ')}`,
  );
  assert.ok(
    !all.includes('≡获取成功:https://old.rss.test/a/1.html'),
    '不得再把重定向前那个地址打成功',
  );
});

test('#699 RSS③ 没重定向 ⇒ 一条回执都不多打', async () => {
  const http: HttpClient = {
    async request(url: string): Promise<HttpResponse> {
      return { status: 200, headers: { 'content-type': 'text/html' }, body: LIST_HTML, url };
    },
  };
  const ctx = makeCtx(http);
  await engine.search(rule, { action: 'search', keyword: 'x', page: 1 } as UnifiedRequest, ctx);
  const all = msgs(ctx);
  assert.ok(!all.some((m) => /检测到重定向/.test(m)), all.join(' | '));
  assert.ok(all.some((m) => m.startsWith('≡获取成功:')), '正常路径的回执不能少');
});
