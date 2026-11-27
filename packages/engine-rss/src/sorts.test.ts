/**
 * `#307` RSS 分类链路（离线测试，不依赖网络）
 *
 * 覆盖两层：
 *  · 纯函数 `rssSortScript` / `parseRssSortUrls` —— 逐条对齐上游 `RssSourceExtensions.kt`；
 *  · 引擎集成 `home()` / `category()` —— 分类条**只来自源规则**（不再注入假「最新」），
 *    选中分类的 url 真的被用去请求（相对补全），而不是把整段多行 sortUrl 当 URL 打出去。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTraceSink, createVariableStore, type EngineContext, type HttpClient, type HttpResponse } from '@yuedu/core';
import { RssEngine } from './engine';
import { parseRssSortUrls, rssSortScript } from './sorts';
import { compileRssSource, type RssSourceRaw } from './model/rss-source';

const compile = (raw: Partial<RssSourceRaw>) =>
  compileRssSource({ sourceUrl: 'https://api.test', sourceName: '测试源', ...raw } as RssSourceRaw);

function makeCtx(http: HttpClient): EngineContext {
  return {
    reqId: 't',
    sourceId: 'fake.test',
    signal: new AbortController().signal,
    http,
    sandbox: { async eval<T = unknown>() { return undefined as T; } },
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: { async get() { return null; }, async set() {}, async delete() {} },
    toastSink: [],
  } as unknown as EngineContext;
}

function makeHttp(pages: Record<string, string>, log: string[]): HttpClient {
  return {
    async request(url: string): Promise<HttpResponse> {
      log.push(url);
      const key = Object.keys(pages).find((k) => url.includes(k));
      return { status: 200, headers: {}, body: key ? pages[key]! : '', url };
    },
  };
}

const XML = `<?xml version="1.0"?><rss><channel>
<item><title>甲</title><link>https://api.test/1</link></item>
<item><title>乙</title><link>https://api.test/2</link></item>
</channel></rss>`;

// ---------------------------------------------------------------------------
// rssSortScript（对齐 extractRssSortScript）
// ---------------------------------------------------------------------------

test('rssSortScript：`@js:` 取前缀之后全部；`<js>…</js>` 取 lastIndexOf 之前', () => {
  assert.equal(rssSortScript('@js: out.join("\\n");'), 'out.join("\\n");');
  assert.equal(rssSortScript('<js>let a=1;</js>'), 'let a=1;');
  // 上游用 lastIndexOf("</js>")：正文里出现 </js> 字面量也按最后一个闭合
  assert.equal(rssSortScript('<js>a="</js>";b=2;</js>'), 'a="</js>";b=2;');
  // 空脚本 / 无闭合 ⇒ null（上游 takeIf{isNotBlank} / closeIndex 判断）
  assert.equal(rssSortScript('@js:   '), null);
  assert.equal(rssSortScript('<js>abc'), null);
  assert.equal(rssSortScript('https://x.test/feed'), null);
  assert.equal(rssSortScript(null), null);
});

// ---------------------------------------------------------------------------
// parseRssSortUrls（对齐 parseRssSortUrls）
// ---------------------------------------------------------------------------

test('parseRssSortUrls：多行 `名称::url` → 多条；相对 url 原样保留（绝对化交给 buildFeedUrl）', () => {
  // 真实语料：凹凸吧（https://www.tuao.cc）
  const raw = '最新::/Articles\n无圣光::/Articles/Categories/1\n\n写真集::/Articles/Categories/4';
  assert.deepEqual(parseRssSortUrls(raw, 'https://www.tuao.cc'), [
    ['最新', '/Articles'],
    ['无圣光', '/Articles/Categories/1'],
    ['写真集', '/Articles/Categories/4'],
  ]);
});

test('parseRssSortUrls：`&&` 也是分隔符；连续分隔符合并为一个', () => {
  const raw = 'A::/a&&B::/b\n\n\nC::/c';
  assert.deepEqual(parseRssSortUrls(raw, 'https://x.test'), [['A', '/a'], ['B', '/b'], ['C', '/c']]);
});

test('parseRssSortUrls：没有 `::` 的项被丢弃；名称可为空；`{{}}` 模板原样保留', () => {
  const raw = 'https://x.test/plain\n::/onlyurl\n带模板::/p/{{page}}';
  assert.deepEqual(parseRssSortUrls(raw, 'https://x.test'), [
    ['', '/onlyurl'],
    ['带模板', '/p/{{page}}'],
  ]);
});

test('parseRssSortUrls：空 sortUrl ⇒ 回落「无名分类 = sourceUrl」', () => {
  assert.deepEqual(parseRssSortUrls('', 'https://x.test'), [['', 'https://x.test']]);
  assert.deepEqual(parseRssSortUrls(null, 'https://x.test'), [['', 'https://x.test']]);
});

test('parseRssSortUrls：**非空但无 `::` 的单 URL sortUrl** ⇒ 原样用作无名分类的 url（不回落 sourceUrl）', () => {
  // 依据：RssViewModel.getSingleUrl(:67-71) 的 else 分支 + RssSortActivity.upFragments(:361) 的 Pair("", url)
  assert.deepEqual(parseRssSortUrls('https://x.test/list?page={{page}}', 'https://x.test'), [
    ['', 'https://x.test/list?page={{page}}'],
  ]);
});

// ---------------------------------------------------------------------------
// 引擎集成：home / category
// ---------------------------------------------------------------------------

test('home：分类条**只来自源规则**（不再注入假「最新」），选中分类的 url 真被用于请求', async () => {
  const rule = compile({ sortUrl: '最新::/Articles\n写真集::/Articles/Categories/4' });
  const log: string[] = [];
  const engine = new RssEngine();

  const home = await engine.home(rule, { action: 'home' }, makeCtx(makeHttp({}, log)));
  assert.equal(home.filters?.length, 1);
  const opts = home.filters![0]!.options;
  assert.deepEqual(opts.map((o) => o.name), ['最新', '写真集']);
  assert.deepEqual(opts.map((o) => o.value), ['/Articles', '/Articles/Categories/4']);
  // ★ 防空转断言：旧实现这里是硬编码的「最新」，本次必须**不再出现**
  assert.ok(!opts.some((o) => o.value === 'feed'), '不应再有 value=feed 的注入分类');

  const cat = await engine.category(
    rule,
    { action: 'category', filters: { explore: '/Articles/Categories/4' }, page: 1 },
    makeCtx(makeHttp({ '/Articles/Categories/4': XML }, log)),
  );
  assert.equal(log[0], 'https://api.test/Articles/Categories/4'); // 相对补全基准 = sourceUrl
  assert.equal(cat.items.length, 2);
  assert.equal(cat.items[0]!.title, '甲');
});

test('category：未选分类 ⇒ 用第一条分类（上游首分类默认），且**不会**把多行 sortUrl 当 URL', async () => {
  const rule = compile({ sortUrl: '最新::/Articles\n写真集::/Articles/Categories/4' });
  const log: string[] = [];
  const cat = await new RssEngine().category(
    rule,
    { action: 'category', page: 1 },
    makeCtx(makeHttp({ '/Articles': XML }, log)),
  );
  assert.equal(log[0], 'https://api.test/Articles');
  assert.ok(!log[0]!.includes('\n'), '请求 URL 不应含换行（多行 sortUrl 未被整段当 URL）');
  assert.equal(cat.items.length, 2);
});

test('home/category：无 sortUrl ⇒ 无名单分类（url = sourceUrl），不伪造分类名', async () => {
  const rule = compile({});
  const log: string[] = [];
  const engine = new RssEngine();
  const home = await engine.home(rule, { action: 'home' }, makeCtx(makeHttp({}, log)));
  assert.deepEqual(home.filters![0]!.options, [{ name: '', value: 'https://api.test' }]);

  const cat = await engine.category(rule, { action: 'category', page: 1 }, makeCtx(makeHttp({ 'https://api.test': XML }, log)));
  assert.equal(log[0], 'https://api.test');
  assert.equal(cat.items.length, 2);
});

// ★ `#317` 旧锁已反转：上游对 `singleUrl` 源是「当一篇文章打开」（`RssFragment.openRss:183`），
//   不是整源拒绝；且 `startHtml` 只作用于渲染层、不影响列表解析。
test('singleUrl ⇒ singleUrlOnly（能力位）；webView 字段只进注记（不门控）', () => {
  // 真实语料：24凹凸（https://www.24ao.cc）singleUrl=true、无 ruleArticles
  const rule = compile({ sourceUrl: 'https://www.24ao.cc', singleUrl: true });
  assert.equal(rule.singleUrlOnly, true);
  // 有列表规则的源不受 singleUrl 字段影响（语料 0 源同时配两者，此条是行为护栏）
  const rss = compile({ sourceUrl: 'https://x.test', singleUrl: true, ruleArticles: '.a' });
  assert.equal(rss.singleUrlOnly, true);
  assert.equal(rule.webViewFeatures.startHtml, false);
  // 有 startHtml 的完整列表源（语料：📖Lofter）不再被整源拒
  const lofterLike = compile({ sourceUrl: 'https://l.test', startHtml: '<html/>', ruleArticles: '.a' });
  assert.equal(lofterLike.webViewFeatures.startHtml, true);
  assert.equal(lofterLike.singleUrlOnly, false);
});

// ---------------------------------------------------------------------------
// `#317` 单 URL 源的通路（对齐上游 RssFragment.openRss:183 + RssViewModel.getSingleUrl:48-70）
// ---------------------------------------------------------------------------

test('`#317` 单 URL 源：home 给「无名分类 = `::` 后段」，且不发任何列表请求', async () => {
  const rule = compile({ sourceUrl: 'https://www.24ao.cc', sourceName: '24凹凸', singleUrl: true, sortUrl: '首页::https://www.24ao.cc/home' });
  const log: string[] = [];
  const home = await new RssEngine().home(rule, { action: 'home' } as never, makeCtx(makeHttp({}, log)));
  const f0 = (home.filters ?? [])[0] as { options?: Array<{ name: string; value: string }> } | undefined;
  assert.equal(f0?.options?.length, 1);
  // 上游 getSingleUrl：含 `::` ⇒ 取第二段
  assert.equal(f0?.options?.[0]?.name, '');
  assert.equal(f0?.options?.[0]?.value, 'https://www.24ao.cc/home');
  // ★ 防空转对偶：上游 `openRss` 对 singleUrl 源**根本不进列表** ⇒ 这里也不该发请求
  assert.equal(log.length, 0);
});

test('`#317` 单 URL 源：category 恒 1 篇（title=源名、link=URL），不发列表请求', async () => {
  const rule = compile({ sourceUrl: 'https://legado.erchuang.online/', sourceName: '阅读 · 全版本汇总', singleUrl: true });
  const log: string[] = [];
  const cat = await new RssEngine().category(rule, { action: 'category', page: 1 } as never, makeCtx(makeHttp({}, log)));
  assert.equal(cat.items.length, 1);
  assert.equal(cat.items[0]!.title, '阅读 · 全版本汇总');
  // sortUrl 空 ⇒ 回落 sourceUrl（上游 getSingleUrl 的第三条分支）
  assert.equal((cat.items[0]!.payload as { link?: string }).link, 'https://legado.erchuang.online/');
  assert.equal((cat.page as { hasMore?: boolean }).hasMore, false);
  assert.equal(log.length, 0);
});

test('`#317` 单 URL 源：sortUrl 是 `@js:` ⇒ 先求值再取 URL（对齐 getSingleUrl）', async () => {
  const rule = compile({ sourceUrl: 'https://s.test', sourceName: 'S', singleUrl: true, sortUrl: '@js: "A::https://s.test/real"' });
  const cat = await new RssEngine().category(rule, { action: 'category', page: 1 } as never, makeCtx(makeHttp({}, [])));
  assert.equal(cat.items.length, 1);
  assert.equal((cat.items[0]!.payload as { link?: string }).link, 'https://s.test/real');
});
