/**
 * 第二批：RssParserByRule 规则引擎（离线测试，不依赖网络）
 *
 * 覆盖：
 *  - parseRssByRule：CSS 列表 / JSON 列表 / `-` 反转 / title 空丢弃 /
 *    link 相对 feedUrl 补全 / image 相对 sourceUrl 补全 / ruleNextPage（PAGE 与规则型）
 *  - buildFeedUrl / buildFeedRequest：`<js>` 前缀先执行 → `::` 后段 → `{{page}}/{{key}}/{{java.*}}` 求值
 *    → `,{options}` 尾巴的 method/body/headers（#328，core url-prep 唯一实现）
 *  - 引擎集成：category 带 {{page}} 翻页、search 带 {{key}}、header 注入
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTraceSink, createVariableStore, createWorkerSandboxPool, type EngineContext, type HttpClient, type HttpResponse } from '@yuedu/core';
import { RssEngine } from './engine';
import { makeRssEnv, buildFeedRequest, buildFeedUrl } from './env';
import { parseRssByRule } from './parser/rss-rule';
import { compileRssSource } from './model/rss-source';
import type { RssSourceRaw } from './model/rss-source';

function makeCtx(http: HttpClient, variables = createVariableStore()): EngineContext {
  return {
    reqId: 't',
    sourceId: 'fake.test',
    signal: new AbortController().signal,
    http,
    sandbox: { async eval<T = unknown>() { return undefined as T; } },
    trace: createTraceSink(),
    variables,
    storage: { async get() { return null; }, async set() {}, async delete() {} },
    toastSink: [],
  } as unknown as EngineContext;
}

function makeHttp(pages: Record<string, string>, log: Array<{ url: string; headers: Record<string, string> }>): HttpClient {
  return {
    async request(url: string, opts?: { headers?: Record<string, string> }): Promise<HttpResponse> {
      log.push({ url, headers: opts?.headers ?? {} });
      const key = Object.keys(pages).find((k) => url.includes(k));
      return { status: 200, headers: {}, body: key ? pages[key]! : '', url };
    },
  };
}

const compile = (raw: Partial<RssSourceRaw>) => compileRssSource({ sourceUrl: 'https://api.test', sourceName: '测试源', ...raw } as RssSourceRaw);

// ---------------------------------------------------------------------------
// `#404` RSS 启动页（startHtml）—— 上游 RssViewModel.launchRssWithHtml / RssFragment.openRss
// ---------------------------------------------------------------------------

test('#404 start：字面量 startHtml/startStyle/startJs 原样返回', async () => {
  const engine = new RssEngine();
  const rule = compile({
    startHtml: '<html><body>启动页</body></html>',
    startStyle: 'body{color:red}',
    startJs: 'console.log(1)',
  });
  const r = await engine.start(rule, { action: 'start' }, makeCtx(makeHttp({}, [])));
  assert.equal(r.html, '<html><body>启动页</body></html>');
  assert.equal(r.style, 'body{color:red}');
  assert.equal(r.js, 'console.log(1)');
});

test('#418 start：随启动页下发源变量快照（沙箱页读不到引擎 ctx ⇒ 由这里带回）', async () => {
  const engine = new RssEngine();
  const rule = compile({ startHtml: '<html/>' });
  const vars = createVariableStore();
  vars.set('sourceVariable', '{"tags":["a"]}');
  const r = await engine.start(rule, { action: 'start' }, makeCtx(makeHttp({}, []), vars));
  assert.equal(r.variable, '{"tags":["a"]}');
  // 从未设置过 ⇒ **空串**（对齐 BaseSource.getVariable()，不是 '{}'）
  const r2 = await engine.start(rule, { action: 'start' }, makeCtx(makeHttp({}, [])));
  assert.equal(r2.variable, '');
});

test('#404 start：@js: startHtml 求值；空串 ⇒ 无启动页（走常规列表）', async () => {
  const engine = new RssEngine();
  const dyn = compile({ startHtml: "@js:'<div>动态启动页</div>'" });
  const r = await engine.start(dyn, { action: 'start' }, makeCtx(makeHttp({}, [])));
  assert.equal(r.html, '<div>动态启动页</div>');
  assert.equal(r.style, undefined, '未配 startStyle ⇒ 不下发该字段');
  assert.equal(r.js, undefined);

  // 18AV 形态：脚本按登录态返回空 ⇒ 上游「无启动页」⇒ 回常规分类列表
  const empty = compile({ startHtml: "@js:''" });
  const r2 = await engine.start(empty, { action: 'start' }, makeCtx(makeHttp({}, [])));
  assert.equal(r2.html, '');
});

test('#404 start：启动页脚本抛错 ⇒ 按无启动页（不抛，warnOnce 留痕）', async () => {
  const engine = new RssEngine();
  const rule = compile({ startHtml: '@js:throw new Error("boom")' });
  const r = await engine.start(rule, { action: 'start' }, makeCtx(makeHttp({}, [])));
  assert.equal(r.html, '');
});

test('#404 start：未配 startHtml ⇒ 空 html（老源零回归）', async () => {
  const engine = new RssEngine();
  const rule = compile({});
  const r = await engine.start(rule, { action: 'start' }, makeCtx(makeHttp({}, [])));
  assert.equal(r.html, '');
});

const LIST_HTML = `
<div class="list">
  <li><a href="/a1" title="第一篇">第一篇</a><span class="date">2026-10-01</span><img src="img/1.jpg"></li>
  <li><a href="/a2" title="第二篇">第二篇</a><span class="date">2026-10-02</span></li>
  <li><a href="/a3" title=""></a></li>
</div>
<div class="next"><a href="/feed?page=2">下一页</a></div>`;

// ---------------------------------------------------------------------------
// parseRssByRule
// ---------------------------------------------------------------------------

test('parseRssByRule：CSS 列表 + title 空丢弃 + link 相对 feedUrl 补全 + image 相对 sourceUrl 补全', async () => {
  const rule = compile({
    ruleArticles: '.list li',
    ruleTitle: 'a@title',
    ruleLink: 'a@href',
    rulePubDate: '.date@text',
    ruleImage: 'img@src',
  });
  const ctx = makeCtx(makeHttp({}, []));
  const env = makeRssEnv(ctx, rule, 'https://api.test');
  const { articles, nextUrl } = await parseRssByRule(LIST_HTML, 'https://api.test/feed', rule, env, '订阅');
  // 第三篇 title 空 → 丢弃
  assert.equal(articles.length, 2);
  assert.equal(articles[0]!.title, '第一篇');
  assert.equal(articles[0]!.link, 'https://api.test/a1'); // 相对补全基准 = feedUrl 的源
  assert.equal(articles[0]!.pubDate, '2026-10-01');
  assert.equal(articles[0]!.image, 'https://api.test/img/1.jpg'); // 基准 = sourceUrl
  assert.equal(articles[0]!.origin, 'https://api.test');
  assert.equal(articles[0]!.sort, '订阅');
  assert.equal(articles[0]!.order, 0);
  assert.equal(nextUrl, null);
});

test('parseRssByRule：`-` 前缀反转列表', async () => {
  const rule = compile({ ruleArticles: '-.list li', ruleTitle: 'a@title', ruleLink: 'a@href' });
  const ctx = makeCtx(makeHttp({}, []));
  const env = makeRssEnv(ctx, rule, 'https://api.test');
  const { articles } = await parseRssByRule(LIST_HTML, 'https://api.test/feed', rule, env, '订阅');
  assert.deepEqual(articles.map((a) => a.title), ['第二篇', '第一篇']);
});

test('parseRssByRule：JSON 列表（$.data[*]）', async () => {
  const rule = compile({ ruleArticles: '$.data[*]', ruleTitle: '$.t', ruleLink: '$.u' });
  const ctx = makeCtx(makeHttp({}, []));
  const env = makeRssEnv(ctx, rule, 'https://api.test');
  const body = JSON.stringify({ data: [{ t: '甲', u: '/1' }, { t: '乙', u: '/2' }] });
  const { articles } = await parseRssByRule(body, 'https://api.test/feed', rule, env, '订阅');
  assert.equal(articles.length, 2);
  assert.equal(articles[0]!.title, '甲');
  assert.equal(articles[1]!.link, 'https://api.test/2');
});

test('parseRssByRule：ruleNextPage=PAGE → nextUrl=sortUrl；规则型 → 相对补全', async () => {
  const base = { ruleArticles: '.list li', ruleTitle: 'a@title', ruleLink: 'a@href' };
  const rulePage = compile({ ...base, ruleNextPage: 'PAGE' });
  const ctx1 = makeCtx(makeHttp({}, []));
  const r1 = await parseRssByRule(LIST_HTML, 'https://api.test/feed', rulePage, makeRssEnv(ctx1, rulePage, 'https://api.test'), '订阅');
  assert.equal(r1.nextUrl, 'https://api.test/feed');

  const ruleRule = compile({ ...base, ruleNextPage: '.next a@href' });
  const ctx2 = makeCtx(makeHttp({}, []));
  const r2 = await parseRssByRule(LIST_HTML, 'https://api.test/feed', ruleRule, makeRssEnv(ctx2, ruleRule, 'https://api.test'), '订阅');
  assert.equal(r2.nextUrl, 'https://api.test/feed?page=2');
});

// ---------------------------------------------------------------------------
// buildFeedUrl（RssViewModel.getSingleUrl + AnalyzeUrl 语义）
// ---------------------------------------------------------------------------

test('buildFeedUrl：`<js>` 前缀先执行（page 绑定）→ 结果替换', async () => {
  const rule = compile({ sortUrl: "<js>'https://x.com/list?page=' + (page - 1)</js>" });
  const ctx = makeCtx(makeHttp({}, []));
  const env = makeRssEnv(ctx, rule, rule.sourceUrl);
  const url = await buildFeedUrl(rule.sortUrl!, rule, env, { page: 2, stripSortPrefix: true });
  assert.equal(url, 'https://x.com/list?page=1');
});

test('buildFeedUrl：JS 失败显式报错（不打出 `<js>` 开头的垃圾 URL）', async () => {
  const rule = compile({ sortUrl: '<js>bad syntax +</js>' });
  const ctx = makeCtx(makeHttp({}, []));
  const env = makeRssEnv(ctx, rule, rule.sourceUrl);
  await assert.rejects(
    () => buildFeedUrl(rule.sortUrl!, rule, env, { page: 1, stripSortPrefix: true }),
    /sortUrl JS 执行失败/,
  );
});

test('buildFeedUrl：{{java.base64Encode}} 走 java 桩 + {{key}}', async () => {
  const rule = compile({ sortUrl: 'https://x.com/q={{key}}&t={{java.base64Encode("abc")}}' });
  const ctx = makeCtx(makeHttp({}, []));
  const env = makeRssEnv(ctx, rule, rule.sourceUrl);
  const url = await buildFeedUrl(rule.sortUrl!, rule, env, { page: 1, key: '词' });
  assert.equal(url, 'https://x.com/q=词&t=YWJj');
});

// ---------------------------------------------------------------------------
// buildFeedRequest（#328：`,{options}` 尾巴的 method/body/headers 生效 —— core url-prep 唯一实现）
// ---------------------------------------------------------------------------

test('buildFeedRequest：POST 尾巴生效（#328 Lofter tagPosts 真实形态，GET 打出业务层 500）', async () => {
  const rule = compile({
    sortUrl: 'https://api.test/tagPosts.api?tag=双女主&offset={{(page-1) *22}}&type=new,{"method": "POST","body":"null"}',
  });
  const ctx = makeCtx(makeHttp({}, []));
  const env = makeRssEnv(ctx, rule, rule.sourceUrl);
  const req = await buildFeedRequest(rule.sortUrl!, rule, env, { page: 2, stripSortPrefix: true });
  assert.equal(req.url, 'https://api.test/tagPosts.api?tag=双女主&offset=22&type=new');
  assert.equal(req.method, 'POST');
  assert.equal(req.body, 'null');
  assert.equal(req.headers, undefined);
});

test('buildFeedRequest：headers 透传；无尾巴时 method/body 不出现（默认 GET 行为不变）', async () => {
  const ctx = makeCtx(makeHttp({}, []));
  const rule = compile({
    sortUrl: 'https://api.test/x,{"method":"POST","headers":{"Content-Type":"application/json"},"body":"{\\"a\\":1}"}',
  });
  const env = makeRssEnv(ctx, rule, rule.sourceUrl);
  const req = await buildFeedRequest(rule.sortUrl!, rule, env, { page: 1, stripSortPrefix: true });
  assert.equal(req.method, 'POST');
  assert.equal(req.headers?.['Content-Type'], 'application/json');
  assert.equal(req.body, '{"a":1}');

  const rule2 = compile({ sortUrl: 'https://api.test/feed?page={{page}}' });
  const env2 = makeRssEnv(ctx, rule2, rule2.sourceUrl);
  const req2 = await buildFeedRequest(rule2.sortUrl!, rule2, env2, { page: 1, stripSortPrefix: true });
  assert.equal(req2.url, 'https://api.test/feed?page=1');
  assert.equal(req2.method, undefined);
  assert.equal(req2.body, undefined);
  assert.equal(req2.headers, undefined);
});

test('buildFeedUrl 兼容包装：POST 模板仍只回纯 URL（尾巴剥离，历史契约不变）', async () => {
  const rule = compile({ sortUrl: 'https://x.com/x,{"method":"POST","body":"null"}' });
  const ctx = makeCtx(makeHttp({}, []));
  const env = makeRssEnv(ctx, rule, rule.sourceUrl);
  const url = await buildFeedUrl(rule.sortUrl!, rule, env, { page: 1, stripSortPrefix: true });
  assert.equal(url, 'https://x.com/x');
});

// ---------------------------------------------------------------------------
// 引擎集成（category / search / header 注入）
// ---------------------------------------------------------------------------

test('category：ruleArticles 源出列表 + {{page}} 翻页 hasMore', async () => {
  const rule = compile({
    sortUrl: 'https://api.test/feed?page={{page}}',
    ruleArticles: '.list li',
    ruleTitle: 'a@title',
    ruleLink: 'a@href',
    ruleNextPage: '.next a@href',
  });
  const log: Array<{ url: string; headers: Record<string, string> }> = [];
  const engine = new RssEngine();
  const r1 = await engine.category(rule, { action: 'category', page: 1 }, makeCtx(makeHttp({ '/feed': LIST_HTML }, log)));
  assert.equal(r1.items.length, 2);
  assert.equal(r1.page.hasMore, true);
  // 翻第 2 页：模板重放 page=2
  await engine.category(rule, { action: 'category', page: 2 }, makeCtx(makeHttp({ '/feed': LIST_HTML }, log)));
  assert.ok(log.some((e) => e.url === 'https://api.test/feed?page=2'));
});

test('category：URL 无 {{page}} + ruleNextPage 规则型 ⇒ hasMore=true 且给出 nextUrl（#306 跨页通道）', async () => {
  const rule = compile({
    sortUrl: 'https://api.test/feed',
    ruleArticles: '.list li',
    ruleTitle: 'a@title',
    ruleLink: 'a@href',
    ruleNextPage: '.next a@href',
  });
  const log: Array<{ url: string; headers: Record<string, string> }> = [];
  const engine = new RssEngine();
  const r = await engine.category(rule, { action: 'category', page: 1 }, makeCtx(makeHttp({ '/feed': LIST_HTML }, log)));
  assert.equal(r.page.hasMore, true, '有跨页通道后应能翻页');
  assert.equal(r.page.nextUrl, 'https://api.test/feed?page=2');

  // 翻第 2 页：前端回传 nextUrl ⇒ 引擎**直接用它**（不是 page+1 重放模板）
  const r2 = await engine.category(rule, { action: 'category', page: 2, nextUrl: r.page.nextUrl }, makeCtx(makeHttp({ '/feed': LIST_HTML }, log)));
  assert.ok(log.some((e) => e.url === 'https://api.test/feed?page=2'), `请求应为 nextUrl：${JSON.stringify(log)}`);
  assert.equal(r2.items.length, 2);
});

test('search：searchUrl 的 {{key}} 求值 + 规则解析', async () => {
  const rule = compile({
    searchUrl: 'https://api.test/search?q={{key}}',
    ruleArticles: '.list li',
    ruleTitle: 'a@title',
    ruleLink: 'a@href',
  });
  const log: Array<{ url: string; headers: Record<string, string> }> = [];
  const engine = new RssEngine();
  const r = await engine.search(rule, { action: 'search', keyword: '测试', page: 1 }, makeCtx(makeHttp({ '/search': LIST_HTML }, log)));
  assert.equal(r.items.length, 2);
  assert.ok(log.some((e) => e.url === 'https://api.test/search?q=测试'));
});

test('header：源级 JSON header 注入请求', async () => {
  const rule = compile({
    sortUrl: 'https://api.test/feed',
    header: '{"User-Agent":"XApp/1.0","X-Token":"abc"}',
  });
  const log: Array<{ url: string; headers: Record<string, string> }> = [];
  const engine = new RssEngine();
  await engine.category(rule, { action: 'category', page: 1 }, makeCtx(makeHttp({ '/feed': '<?xml version="1.0"?><rss><item><title>t</title></item></rss>' }, log)));
  const ua = log[0]!.headers['User-Agent'];
  assert.equal(ua, 'XApp/1.0');
  assert.equal(log[0]!.headers['X-Token'], 'abc');
});

// ---------------------------------------------------------------------------
// `#415` POST 默认 Content-Type（Legado `AnalyzeUrl.kt:286-289`，与 engine-legado 同一条）
//
// 真源取证（LOFTER `https://api.lofter.com/recommend/domainPosts.json`）：
//   带 `Content-Type: application/x-www-form-urlencoded` ⇒ 200 且 `data.list` 9~10 条；
//   不带（本引擎旧行为）⇒ 200 但 `data.list: []` ⇒ `SELECTOR_MISS@parse`（用户症状）。
// ---------------------------------------------------------------------------

test('#415 列表：POST 尾巴未声明 Content-Type ⇒ 补默认表单头（缺头站点静默返回空列表）', async () => {
  const rule = compile({
    sortUrl: 'https://api.test/domainPosts.json?product=x,{"method":"POST","body":"domainId=1&offset={{(page-1)*10}}"}',
    ruleArticles: '.list li',
    ruleTitle: 'a@title',
  });
  const log: Array<{ url: string; headers: Record<string, string> }> = [];
  await new RssEngine().category(rule, { action: 'category', page: 1 }, makeCtx(makeHttp({ '/domainPosts': LIST_HTML }, log)));
  assert.equal(log[0]!.headers['content-type'], 'application/x-www-form-urlencoded');
});

test('#415 正文：link 的 POST 尾巴同样补默认表单头（缺头站点卡片点开正文空白）', async () => {
  const rule = compile({ ruleContent: '.content@html' });
  const log: Array<{ url: string; headers: Record<string, string> }> = [];
  const c = await new RssEngine().content(
    rule,
    { action: 'content', id: JSON.stringify({ title: '文章一', link: 'https://api.test/detail.api,{"method":"POST","body":"postid=1"}' }) },
    makeCtx(makeHttp({ '/detail.api': ART1 }, log)),
  );
  assert.match(c.html ?? '', /正文第一段/, '正文必须真的取到（补头后 API 才给内容）');
  assert.equal(log[0]!.headers['content-type'], 'application/x-www-form-urlencoded');
});

test('#415 对偶：JSON 体 ⇒ application/json；源已显式声明 ⇒ 原样不覆盖', async () => {
  const jsonRule = compile({ sortUrl: 'https://api.test/x,{"method":"POST","body":"{\\"a\\":1}"}', ruleArticles: '.list li', ruleTitle: 'a@title' });
  const log1: Array<{ url: string; headers: Record<string, string> }> = [];
  await new RssEngine().category(jsonRule, { action: 'category', page: 1 }, makeCtx(makeHttp({ '/x': LIST_HTML }, log1)));
  assert.equal(log1[0]!.headers['content-type'], 'application/json');

  const explicit = compile({ sortUrl: 'https://api.test/y,{"method":"POST","headers":{"Content-Type":"text/plain"},"body":"a=1"}', ruleArticles: '.list li', ruleTitle: 'a@title' });
  const log2: Array<{ url: string; headers: Record<string, string> }> = [];
  await new RssEngine().category(explicit, { action: 'category', page: 1 }, makeCtx(makeHttp({ '/y': LIST_HTML }, log2)));
  assert.equal(log2[0]!.headers['Content-Type'], 'text/plain', '源显式声明的头不得被默认值覆盖');
});

test('#415 对偶：GET（无 POST method）不补 content-type', async () => {
  const rule = compile({ sortUrl: 'https://api.test/feed', ruleArticles: '.list li', ruleTitle: 'a@title' });
  const log: Array<{ url: string; headers: Record<string, string> }> = [];
  await new RssEngine().category(rule, { action: 'category', page: 1 }, makeCtx(makeHttp({ '/feed': LIST_HTML }, log)));
  assert.equal(log[0]!.headers['content-type'], undefined);
});

// ---------------------------------------------------------------------------
// `#421` 列表 0 条 ⇒ 回落渲染层（JS 单页应用；七猫高清 `.v-item` 真机形态）
// ---------------------------------------------------------------------------

test('#421 category：静态规则 0 条 + 有渲染层 ⇒ 渲染一次后按同一规则解析', async () => {
  const rule = compile({ sortUrl: 'https://api.test/list.html', ruleArticles: '.v-item', ruleTitle: '.v-title@text', ruleLink: 'a@href' });
  const calls: Array<{ url: string; opts?: Record<string, unknown> }> = [];
  const ctx = makeRenderCtx(calls, '<div class="grid-video"><a class="v-item" href="/p/1"><div class="v-title">渲染出的卡片</div></a></div>');
  // 静态页只有空壳（`#list-root`），没有 `.v-item` —— 真机七猫高清正是这个形态
  (ctx as unknown as Record<string, unknown>).http = makeHttp({ '/list.html': '<div id="list-root"></div>' }, []);
  const r = await new RssEngine().category(rule, { action: 'category', page: 1 }, ctx);
  assert.equal(r.items.length, 1, `渲染回落应出 1 条：${JSON.stringify(r.items)}`);
  assert.equal(calls.length, 1, '应恰好渲染一次');
  assert.equal(r.items[0]!.title, '渲染出的卡片');
});

test('#421【对偶】静态就能出结果时**不渲染**（零回归）', async () => {
  const rule = compile({ sortUrl: 'https://api.test/list.html', ruleArticles: '.list li', ruleTitle: 'a@title' });
  const calls: Array<{ url: string; opts?: Record<string, unknown> }> = [];
  const ctx = makeRenderCtx(calls, '<div class="v-item">不该被用到</div>');
  (ctx as unknown as Record<string, unknown>).http = makeHttp({ '/list.html': LIST_HTML }, []);
  const r = await new RssEngine().category(rule, { action: 'category', page: 1 }, ctx);
  assert.equal(r.items.length, 2);
  assert.equal(calls.length, 0, '能出结果就不得触发渲染');
});

test('#421【对偶】无渲染层时保持原错误语义（SELECTOR_MISS）', async () => {
  const rule = compile({ sortUrl: 'https://api.test/list.html', ruleArticles: '.v-item', ruleTitle: '.t@text' });
  await assert.rejects(
    () => new RssEngine().category(rule, { action: 'category', page: 1 }, makeCtx(makeHttp({ '/list.html': '<div id="list-root"></div>' }, []))),
    /SELECTOR_MISS/,
  );
});

test('category：payload 全量带 description（#322 —— content() 第一通路靠它），无 ruleDescription 的源为 null（对偶）', async () => {
  const jsonBody = JSON.stringify({
    list: [
      { vod_name: '剧A', vod_pic: 'http://i.test/a.jpg', vod_id: 1 },
      { vod_name: '剧B', vod_id: 2 },
    ],
  });
  const mk = (ruleDescription?: string) =>
    compile({
      sortUrl: 'https://api.test/feed',
      ruleArticles: '$.list[*]',
      ruleTitle: '$.vod_name',
      ruleLink: 'https://api.test/detail?ids={{$.vod_id}}',
      ...(ruleDescription ? { ruleDescription } : {}),
    });
  const engine = new RssEngine();

  // 配了 ruleDescription ⇒ 求值结果必须进 payload（上游点文章传整篇文章对象，
  // description 非空时 ReadRssActivity 直接当完整 HTML 用 —— 丢字段 = 正文通路断）
  const withDesc = mk('<div class="player">{{$.vod_name}}</div>');
  const r1 = await engine.category(withDesc, { action: 'category', page: 1 }, makeCtx(makeHttp({ '/feed': jsonBody }, [])));
  assert.equal(r1.items.length, 2);
  const p1 = r1.items[0]?.payload as { description?: unknown } | undefined;
  const p2 = r1.items[1]?.payload as { description?: unknown } | undefined;
  assert.equal(p1?.description, '<div class="player">剧A</div>');
  assert.equal(p2?.description, '<div class="player">剧B</div>');

  // `#434`：**卡片 `summary` 必须净化**（与 engine-legado 列表项同一口径）。
  // payload.description 仍是原 HTML（上面两条锁住），只有卡片字段被剥标签。
  assert.equal(r1.items[0]?.summary, '剧A');

  // 对偶：没配 ruleDescription ⇒ description 恒 null（key 仍在，content() 的 `p.description || ''` 不歧义）
  const noDesc = mk();
  const r2 = await engine.category(noDesc, { action: 'category', page: 1 }, makeCtx(makeHttp({ '/feed': jsonBody }, [])));
  assert.equal((r2.items[0]?.payload as { description?: unknown } | undefined)?.description, null);
  assert.equal(r2.items[0]?.summary, undefined);
});

test('category：卡片 summary 剥标签 + 去 HTML 注释（#434），payload.description 仍保原 HTML', async () => {
  const jsonBody = JSON.stringify({ list: [{ vod_name: '甲', vod_id: 1 }] });
  const rule = compile({
    sortUrl: 'https://api.test/feed',
    ruleArticles: '$.list[*]',
    ruleTitle: '$.vod_name',
    ruleLink: 'https://api.test/detail?ids={{$.vod_id}}',
    // ⚠️ 必须含 `{{}}` 才被当**字面模板**求值（纯 HTML 无占位符会被当 CSS 选择器 ⇒ 恒空，
    // 与上面 418 行那条用例同因）—— 这里用 `{{$.vod_name}}` 钉住「取得到值」。
    ruleDescription: '<p>简介一</p><!-- 关闭阅读新版的放大功能 --><div>{{$.vod_name}}第二段</div>',
  });
  const r = await new RssEngine().category(rule, { action: 'category', page: 1 }, makeCtx(makeHttp({ '/feed': jsonBody }, [])));
  const item = r.items[0];
  // 标签与注释都不许漏进卡片描述（块级标签还原换行）
  assert.equal(item?.summary, '简介一\n甲第二段');
  // 正文通路未受影响：payload.description 原样带注释与标签
  assert.equal(
    (item?.payload as { description?: string } | undefined)?.description,
    '<p>简介一</p><!-- 关闭阅读新版的放大功能 --><div>甲第二段</div>',
  );
});

test('category：卡片 subtitle（rulePubDate）同样净化 —— 实测该源 pubDate 规则尾部内嵌整页 HTML（#435）', async () => {
  // 语料：「影视聚合(资源站)」的 rulePubDate 尾部直接拼 `{{$.vod_content}}`（= 整篇简介 + `<style>`）
  // ⇒ 卡片第二行会漏出 CSS 源码与 `</p>`（用户实测「有非简介信息暴露」）
  const jsonBody = JSON.stringify({
    list: [{ vod_name: '意思夫妇', vod_id: 1, vod_score: '5.4', vod_content: '<style>*{margin:0;padding:0;}</style><p>简介如下</p>' }],
  });
  const rule = compile({
    sortUrl: 'https://api.test/feed',
    ruleArticles: '$.list[*]',
    ruleTitle: '$.vod_name',
    ruleLink: 'https://api.test/detail?ids={{$.vod_id}}',
    rulePubDate: '🔖{{$.vod_score}} &nbsp;📆2026-10-12{{$.vod_content}}',
  });
  const r = await new RssEngine().category(rule, { action: 'category', page: 1 }, makeCtx(makeHttp({ '/feed': jsonBody }, [])));
  const it = r.items[0];
  const sub = String(it?.subtitle ?? '');
  assert.ok(sub, 'subtitle 应有值');
  assert.ok(!sub.includes('margin:0'), `CSS 内容不得漏进卡片副标题，实际：${sub}`);
  assert.ok(!sub.includes('<p>') && !sub.includes('</p>'), `标签不得漏出，实际：${sub}`);
  assert.ok(sub.includes('5.4') && sub.includes('2026-10-12'), `日期/评分要留下，实际：${sub}`);
  assert.ok(sub.includes('简介如下'), `简介正文要留下，实际：${sub}`);
  // payload 仍保原文（正文 content() 与目录 tag 用得到）
  assert.match(String((it?.payload as { pubDate?: string } | undefined)?.pubDate ?? ''), /<style>/, 'payload.pubDate 必须保留原 HTML');
});

// ---------------------------------------------------------------------------
// 第三批：content 正文规则（ruleContent）+ nextContentUrl 追页
// ---------------------------------------------------------------------------

const ART1 = `<html><body><div class="content"><p>正文第一段</p><p>正文第二段</p></div>
<a class="next" href="/a1?p=2">下一页</a></body></html>`;
const ART2 = `<html><body><div class="content"><p>正文第三段</p></div></body></html>`;

// ---------------------------------------------------------------------------
// `#419` 正文 link 的 `@js:` 段与 URL 选项 `type`（18AV `data:;base64,…` hex 通道）
//
// 真机症状：正文报 `Illegal hexadecimal character "<"`（站点把畸形 URL 回成 HTML 错误页）。
// 列表面 `buildFeedRequest` 早已跑 `applyUrlRuleJs` + 透传 `type`，正文面漏了这两件。
// ---------------------------------------------------------------------------

test('#419 content：link 的 `@js:` 段先求值 ⇒ 请求打到 data: URL（不再把 `@js:` 尾巴当 URL）', async () => {
  const b64 = Buffer.from('/zh/chinese_content/1.html', 'utf-8').toString('base64');
  const link = `https://site.test/a.html@js:'data:;base64,${b64},{"type":"18av"}'`;
  const got: Array<{ url: string; rt?: string }> = [];
  const http: HttpClient = {
    async request(url, opts) {
      const rt = (opts as { responseType?: string })?.responseType;
      got.push({ url: String(url), ...(rt ? { rt } : {}) });
      // hex 通道：返回**字节**（引擎据 `type` 转 hex 交给规则）
      const bytes = new TextEncoder().encode('/zh/chinese_content/1.html');
      return { status: 200, headers: {}, body: bytes.buffer as ArrayBuffer, url };
    },
  } as HttpClient;
  const rule = compile({ ruleContent: '@js:java.hexDecodeToString(result)' });
  const c = await new RssEngine().content(
    rule,
    { action: 'content', id: JSON.stringify({ title: 'T', link, type: 0 }) },
    makeCtx(http),
  );
  assert.equal(got.length, 1, `应只发一次请求：${JSON.stringify(got)}`);
  assert.equal(got[0]!.url, `data:;base64,${b64}`, 'URL 必须是 JS 求值后的 data: URL（旧实现把 `@js:` 尾巴整串当 URL）');
  assert.equal(got[0]!.rt, 'arraybuffer', '`type` 选项必须透传 ⇒ 走 hex 通道');
  assert.match(c.html ?? '', /\/zh\/chinese_content\/1\.html/, 'hex 解出的路径应交给规则（不再抛 Illegal hexadecimal character）');
});

test('#419【对偶】无 `@js:` 尾的普通 link 仍原样请求（不吃本次改动）', async () => {
  const rule = compile({ ruleContent: '.content@html' });
  const log: Array<{ url: string }> = [];
  await new RssEngine().content(
    rule,
    { action: 'content', id: JSON.stringify({ title: 'T', link: 'https://api.test/a1' }) },
    makeCtx(makeHttp({ '/a1': ART1 }, log as never)),
  );
  assert.equal(log[0]!.url, 'https://api.test/a1');
});

test('content：无内嵌正文 + ruleContent ⇒ 抓内容页，(#308) 结果作 HTML 下发', async () => {
  const rule = compile({ ruleContent: '.content@html' });
  const log: Array<{ url: string }> = [];
  const engine = new RssEngine();
  const c = await engine.content(
    rule,
    { action: 'content', id: JSON.stringify({ title: '文章一', link: 'https://api.test/a1' }) },
    makeCtx(makeHttp({ '/a1': ART1 }, log as never)),
  );
  // `#308`：上游把这结果当完整 HTML 交给 WebView（`loadDataWithBaseURL`），
  // 所以契约上是 `html`（与 `paragraphs` 互斥），**不再**降级成段落数组。
  assert.equal(c.paragraphs.length, 0, 'html 与 paragraphs 互斥');
  assert.match(c.html ?? '', /正文第一段/, 'HTML 里应含正文');
  assert.equal(c.htmlBaseUrl, 'https://api.test/a1', 'baseUrl = 文章绝对地址（loadWithBaseUrl 默认 true）');
  assert.ok(log.some((e) => e.url === 'https://api.test/a1'));
});

// ---------------------------------------------------------------------------
// `#334` 正文页状态码闸门：4xx/5xx 不再当正文下发（听友FM 直出 404 JSON 的整类修）
// ---------------------------------------------------------------------------

/** 可指定状态码的 http 桩（现成 `makeHttp` 恒 200，这里要的是「错误页有 body」的形态） */
function makeStatusHttp(status: number, body: string): HttpClient {
  return {
    async request(url: string): Promise<HttpResponse> {
      return { status, headers: {}, body, url };
    },
  };
}

const BAD_LINK = JSON.stringify({ title: '文章一', link: 'https://api.test/a1' });

test('#334 content：正文页 HTTP 404 ⇒ 抛 NETWORK（不把 404 JSON 当正文下发）', async () => {
  const rule = compile({ ruleContent: '.content@html' });
  const engine = new RssEngine();
  const ctx = makeCtx(makeStatusHttp(404, '{"detail":"Page not found"}'));
  await assert.rejects(
    () => engine.content(rule, { action: 'content', id: BAD_LINK }, ctx),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'NETWORK', `应为 NETWORK，实际 ${String(e)}`);
      const d = (e as { detail?: { input?: unknown } }).detail;
      assert.match(String(d?.input ?? ''), /404/, `错误信息要带状态码，实际 ${JSON.stringify(d)}`);
      return true;
    },
    '404 错误页必须被拦（否则源的 `return raw` 兜底会把整页 JSON 直出给用户）',
  );
});

test('#334 对偶（防空转）：同一条链路 200 ⇒ 照常解析出正文', async () => {
  const rule = compile({ ruleContent: '.content@html' });
  const engine = new RssEngine();
  // 与上面**同一条链路、同一份 URL**，只把状态码换回 200 ⇒ 必须解析出正文
  const ctx = makeCtx(makeStatusHttp(200, ART1));
  const c = await engine.content(rule, { action: 'content', id: BAD_LINK }, ctx);
  assert.match(c.html ?? '', /正文第一段/, `200 时应正常出正文：${String(c.html).slice(0, 120)}`);
});

test('#334 content：nextContentUrl 追页 404 ⇒ 跳过该页，不中断整篇', async () => {
  const rule = compile({ ruleContent: '.content@html', nextContentUrl: '.next@href' });
  const engine = new RssEngine();
  const ctx = makeCtx({
    async request(url: string): Promise<HttpResponse> {
      // 首页 200（含「下一页」）· 追页 404 ⇒ 只保留首页，不抛错
      if (url.includes('p=2')) return { status: 404, headers: {}, body: 'not found', url };
      return { status: 200, headers: {}, body: ART1, url };
    },
  } as HttpClient);
  const c = await engine.content(rule, { action: 'content', id: BAD_LINK }, ctx);
  assert.match(c.html ?? '', /正文第一段/, '首页正文应保留');
});

test('content：nextContentUrl 单条链式追页 → 两页拼接', async () => {
  const rule = compile({ ruleContent: '.content@html', nextContentUrl: '.next@href' });
  const pages: Record<string, string> = { '/a1?p=2': ART2, '/a1': ART1 };
  const engine = new RssEngine();
  const c = await engine.content(
    rule,
    { action: 'content', id: JSON.stringify({ title: '文章一', link: 'https://api.test/a1' }) },
    makeCtx(makeHttp(pages, [])),
  );
  // 两页都在同一份 HTML 里（`chunks.join('\n')`），顺序按追页顺序
  const h = c.html ?? '';
  assert.ok(h.includes('正文第一段') && h.includes('正文第二段') && h.includes('正文第三段'), h.slice(0, 200));
  assert.ok(h.indexOf('正文第二段') < h.indexOf('正文第三段'), '第二页内容应排在第一页之后');
});

test('content：nextContentUrl 多条 ⇒ 并发追页（首后全页）', async () => {
  const multi = ART1.replace('<a class="next" href="/a1?p=2">下一页</a>',
    '<a class="next" href="/p2">2</a><a class="next" href="/p3">3</a>');
  const rule = compile({ ruleContent: '.content@html', nextContentUrl: '.next@href' });
  const pages: Record<string, string> = { '/a1': multi, '/p2': ART2, '/p3': ART1 };
  const engine = new RssEngine();
  const c = await engine.content(
    rule,
    { action: 'content', id: JSON.stringify({ title: '文章一', link: 'https://api.test/a1' }) },
    makeCtx(makeHttp(pages, [])),
  );
  // 首页 2 段 + /p2（ART2 1 段）+ /p3（ART1 2 段）= 5 段，说明后续页**都被取回**且按顺序拼接
  const h = c.html ?? '';
  assert.equal((h.match(/正文第[一二三]段/g) ?? []).length, 5, h.slice(0, 300));
});

test('content：ruleDescription 解析出的 description 直接作为正文（对齐上游 resolveRssReadLoadTarget 的 CachedContent 分支）', async () => {
  // 用户口径：「最后的正文页面是可以由描述规则（ruleDescription）自定义的」。
  // 上游 `resolveRssReadLoadTarget`（ReadRssViewModel.kt:46-59）第一优先就是
  // `description 非空 ⇒ 直接用`——不再抓内容页。
  const rule = compile({ ruleDescription: '.content@html' }); // 刻意**不配** ruleContent
  const log: Array<{ url: string }> = [];
  const engine = new RssEngine();
  const c = await engine.content(
    rule,
    { action: 'content', id: JSON.stringify({ title: '甲', link: 'https://api.test/a1', description: '<p>描述即正文</p>' }) },
    makeCtx(makeHttp({ '/a1': ART1 }, log as never)),
  );
  assert.equal(c.paragraphs.length, 0);
  assert.match(c.html ?? '', /描述即正文/, 'description 应原样作为 HTML 下发（#308）');
  // 防空转：既没去抓内容页，也就不会出 ART1 里的「正文第一段」
  assert.ok(!log.some((e) => e.url === 'https://api.test/a1'), 'description 非空时不应再请求内容页');
});

test('content：ruleContent 为 `@js:` ⇒ 正文由用户代码生成（org.jsoup 桥可用）', async () => {
  // 用户口径：「内容规则（ruleContent）也可以由用户代码生成的」。
  // 语料实测：330 个 RSS 源里 62 个 ruleContent 是 `@js:` 型，主流写法正是
  // `org.jsoup.Jsoup.parse(result).select(...)`（core 的 jsoup 桥已实现）。
  const rule = compile({
    ruleContent: '@js:\nvar doc = org.jsoup.Jsoup.parse(result);\nvar ps = doc.select(".content p");\nvar out = "";\nfor (var i = 0; i < ps.size(); i++) out += "<p>[JS]" + ps.get(i).text() + "</p>";\nout;',
  });
  const engine = new RssEngine();
  const c = await engine.content(
    rule,
    { action: 'content', id: JSON.stringify({ title: '甲', link: 'https://api.test/a1' }) },
    makeCtx(makeHttp({ '/a1': ART1 }, [])),
  );
  assert.equal(c.paragraphs.length, 0);
  assert.match(c.html ?? '', /<p>\[JS\]正文第一段<\/p>/, '规则产出的 HTML 标签必须原样保留（#308）');
  assert.match(c.html ?? '', /<p>\[JS\]正文第二段<\/p>/);
});

test('content：图片型（type=1）抓页后抽图', async () => {
  const imgs = `<html><body><div class="content"><img src="https://api.test/p1.jpg"><img src="https://api.test/p2.jpg"></div></body></html>`;
  const rule = compile({ ruleContent: '.content@html' });
  const engine = new RssEngine();
  const c = await engine.content(
    rule,
    { action: 'content', id: JSON.stringify({ title: '图集', type: 1, image: 'https://api.test/cover.jpg', link: 'https://api.test/g1' }) },
    makeCtx(makeHttp({ '/g1': imgs }, [])),
  );
  assert.equal(c.imageStyle, 'FULL');
  assert.deepEqual(c.paragraphs, ['https://api.test/cover.jpg', 'https://api.test/p1.jpg', 'https://api.test/p2.jpg']);
});

test('content：有内嵌正文 → 不抓内容页（上游 description 优先）', async () => {
  const rule = compile({ ruleContent: '.content@html' });
  const log: Array<{ url: string }> = [];
  const engine = new RssEngine();
  const c = await engine.content(
    rule,
    { action: 'content', id: JSON.stringify({ title: 't', link: 'https://api.test/a1', description: '<p>内嵌段</p>' }) },
    makeCtx(makeHttp({ '/a1': ART1 }, log as never)),
  );
  assert.equal(c.paragraphs.length, 0);
  assert.match(c.html ?? '', /<p>内嵌段<\/p>/);
  assert.equal(log.length, 0, '有内嵌正文时不应请求内容页');
});

test('content：rssArticle 实体注入生效（规则可读文章字段）', async () => {
  const rule = compile({ ruleContent: '<js>rssArticle.title</js>' });
  const engine = new RssEngine();
  const c = await engine.content(
    rule,
    { action: 'content', id: JSON.stringify({ title: '我是标题', link: 'https://api.test/a1' }) },
    makeCtx(makeHttp({ '/a1': ART1 }, [])),
  );
  assert.equal(c.paragraphs.length, 0);
  assert.match(c.html ?? '', /我是标题/, '规则可读到 rssArticle 字段');
});

// ---------------------------------------------------------------------------
// #304：detail 两种入参形态（单篇文章 / feed URL）
// ---------------------------------------------------------------------------

test('detail：前端传文章 payload（JSON.stringify）⇒ 单章目录，不再把 JSON 当 URL', async () => {
  const rule = compile({ sortUrl: 'https://api.test/feed', ruleArticles: '.list li', ruleTitle: 'a@title', ruleLink: 'a@href', rulePubDate: '.date@text' });
  // 前端 fetchDetail 传的是 JSON.stringify(payload)（stores/reader.ts:2062）
  const payload = { title: '文章一', link: 'https://api.test/a1', order: 0, type: 0 };
  const engine = new RssEngine();
  const d = await engine.detail(rule, { action: 'detail', id: JSON.stringify(payload) }, makeCtx(makeHttp({}, [])));
  assert.equal(d.chapters?.length, 1, '单篇文章 ⇒ 单章目录');
  assert.equal(d.title, '文章一');
  assert.equal(d.id, 'https://api.test/a1');
  assert.equal((d.chapters?.[0]?.payload as { link?: string })?.link, 'https://api.test/a1');
});

test('detail：纯 URL（feed）⇒ 整源文章列表（对偶：两种形态不落同一位置）', async () => {
  const rule = compile({ sortUrl: 'https://api.test/feed', ruleArticles: '.list li', ruleTitle: 'a@title', ruleLink: 'a@href' });
  const engine = new RssEngine();
  const d = await engine.detail(rule, { action: 'detail', id: 'https://api.test/feed' }, makeCtx(makeHttp({ '/feed': LIST_HTML }, [])));
  assert.ok((d.chapters?.length ?? 0) === 2, `n=${d.chapters?.length}`);
  assert.equal(d.title, '测试源', '整源模式标题 = 源名');
});

// ---------------------------------------------------------------------------
// #305：webView 型阅读（渲染层渲染内容页）
// ---------------------------------------------------------------------------

/** 带渲染器的 ctx（mock：返回一页含正文的 HTML，并记录调用参数） */
function makeRenderCtx(calls: Array<{ url: string; opts?: Record<string, unknown> }>, html: string): EngineContext {
  const ctx = makeCtx(makeHttp({}, []));
  (ctx as unknown as Record<string, unknown>).webRenderer = async (url: string, opts?: Record<string, unknown>) => {
    calls.push({ url, opts });
    return html;
  };
  return ctx;
}

test('content：无内嵌正文 + 无 ruleContent + 有渲染层 ⇒ 渲染 link 读正文', async () => {
  const calls: Array<{ url: string; opts?: Record<string, unknown> }> = [];
  const rule = compile({
    style: '.content{color:#333}',
    injectJs: 'window.x=1',
    // `#449` 源的页面内跳转判定（语料 240 源里 9 个声明了它）
    shouldOverrideUrlLoading: '(function(){return url.indexOf("mod=viewthread")>=0})()',
  });
  const engine = new RssEngine();
  const c = await engine.content(
    rule,
    { action: 'content', id: JSON.stringify({ title: '网页型文章', link: 'https://api.test/p1' }) },
    makeRenderCtx(calls, '<html><body><div class="content"><p>渲染出来的第一段</p><p>第二段</p></div></body></html>'),
  );
  assert.equal(c.paragraphs.length, 0);
  assert.match(c.html ?? '', /渲染出来的第一段/);
  assert.match(c.html ?? '', /<style>\.content\{color:#333\}<\/style>/, 'style 应塞进 HTML（渲染层只接受 js）');
  assert.equal(calls[0]?.url, 'https://api.test/p1');
  // injectJs 透传给渲染层；style 塞进 HTML（渲染层只接受 js，不接受 CSS）
  assert.equal(calls[0]?.opts?.js, 'window.x=1');
  /**
   * `#446` **正文面也必须执行 `injectJs`**（对齐上游 `onPageFinished` 的 evaluateJavascript）。
   * 用户实测千白羽详情页「外观设置」按钮死的真因：源把面板构造函数 `window.detailBuildPanel`
   * 放在 `injectJs` 里，而详情页脚本的 `bgPanel()` 调它 —— 我们不跑 `injectJs` ⇒
   * `TypeError: window.detailBuildPanel is not a function` ⇒ 按钮全无反应。
   */
  assert.match(c.html ?? '', /<script>window\.x=1<\/script>/, 'injectJs 必须作为脚本进正文 HTML');
  assert.ok(
    (c.html ?? '').indexOf('<script>window.x=1</script>') < (c.html ?? '').indexOf('</body>'),
    'injectJs 必须落在 `</body>` 之前（= 页面自身脚本之后，与上游 onPageFinished 同序）',
  );
  /**
   * `#449` **`shouldOverrideUrlLoading` 也要下发到页面**（用户口径：「为什么是 D13 的事？现在不能支持么？」）。
   * 上游是 WebView 导航前跑它（`url` 在作用域）⇒ 壳层导航桥按它决定「拦下来交源规则 / 放行通用分流」。
   */
  assert.match(c.html ?? '', /window\.__yueduShouldOverride=function\(url\)/, '源字段必须下发成页面内判定函数');
  assert.match(c.html ?? '', /eval\("\(function\(\)\{return url\.indexOf/, '字段原文要原样进 eval（两种形态都容）');
});

test('content：无渲染层 ⇒ 显式 UNSUPPORTED（不静默返回空正文）', async () => {
  const rule = compile({});
  const engine = new RssEngine();
  await assert.rejects(
    () => engine.content(
      rule,
      { action: 'content', id: JSON.stringify({ title: '网页型文章', link: 'https://api.test/p1' }) },
      makeCtx(makeHttp({}, [])), // 无 webRenderer
    ),
    (e: unknown) => (e as { code?: string }).code === 'UNSUPPORTED_ACTION',
  );
});

// ---------------------------------------------------------------------------
// #382：sortUrl/sourceUrl 中缀 `@js:`（qyyuapi 聚合源真实形态 `Movieffm@js:`…``）
// ---------------------------------------------------------------------------

test('buildFeedRequest：@js: 在 URL 中间也求值，分类名前缀被丢弃（#382 上游 analyzeJs 全文扫描语义）', async () => {
  const rule = compile({ sortUrl: "Movieffm@js:`https://qyyuapi.com/cats/popular-movies/`" });
  const ctx = makeCtx(makeHttp({}, []));
  const env = makeRssEnv(ctx, rule, rule.sourceUrl);
  const req = await buildFeedRequest(rule.sortUrl!, rule, env, { page: 1 });
  assert.equal(req.url, 'https://qyyuapi.com/cats/popular-movies/');
});

test('buildFeedRequest：中缀 @js: 结果里的 {{}} 在 JS 之后求值（上游 replaceKeyPageJs 顺序）', async () => {
  const rule = compile({ sortUrl: "Movieffm@js:`{{page}}/cats/`" });
  const ctx = makeCtx(makeHttp({}, []));
  const env = makeRssEnv(ctx, rule, rule.sourceUrl);
  const req = await buildFeedRequest(rule.sortUrl!, rule, env, { page: 3 });
  assert.equal(req.url, 'https://api.test/3/cats/');
});

// ---------------------------------------------------------------------------
// `#434` 封面解密（coverDecodeJs）—— 移植自 engine-legado.decodeImage
//   · `result` 必须是 InputStream 语义（源脚本用 result.readAllBytes()）
//   · 未声明 / 抛错 / 返回非字节 ⇒ null（调用方回传原图，不让解密失败打断加载）
// ---------------------------------------------------------------------------

test('#434 decodeImage：coverDecodeJs 恒等规则返回原字节（result 走 InputStream 语义）', async () => {
  const engine = new RssEngine();
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const rule = compile({ coverDecodeJs: 'result.readAllBytes()' });
  const out = await engine.decodeImage(
    rule,
    { url: 'https://img.test/a.jpg', bytes, isCover: true },
    makeCtx(makeHttp({}, [])),
  );
  assert.ok(out, '应返回解密结果');
  assert.deepEqual(Buffer.from(out), Buffer.from(bytes));
});

// `#759`：auto 默认为小图留 L1（实测跨线程往返无收益）⇒ 「必须走 worker」的用例显式强制 on
function withImageWorkerOn<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env['YUEDU_IMAGE_DECODE_WORKER'];
  process.env['YUEDU_IMAGE_DECODE_WORKER'] = '1';
  return fn().finally(() => {
    if (prev === undefined) delete process.env['YUEDU_IMAGE_DECODE_WORKER'];
    else process.env['YUEDU_IMAGE_DECODE_WORKER'] = prev;
  });
}

test('#759 decodeImage：RSS 封面解密下移 worker（裸字节描述符），字节一致', async () => {
  await withImageWorkerOn(async () => {
    const pool = createWorkerSandboxPool({ size: 1 });
    const jobs: Array<{ bindings?: Record<string, unknown> }> = [];
    const orig = pool.eval.bind(pool);
    (pool as unknown as { eval: typeof pool.eval }).eval = (opts) => {
      jobs.push(opts);
      return orig(opts);
    };
    try {
      const engine = new RssEngine();
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
      const rule = compile({ coverDecodeJs: 'result.readAllBytes()' });
      const ctx = makeCtx(makeHttp({}, []));
      (ctx as unknown as { sandbox: unknown }).sandbox = pool;
      const out = await engine.decodeImage(rule, { url: 'https://img.test/w.jpg', bytes, isCover: true }, ctx);
      assert.ok(out);
      assert.deepEqual(Buffer.from(out), Buffer.from(bytes));
      assert.ok(
        jobs.some((j) => j.bindings?.['__yueduImageBytes'] instanceof Uint8Array),
        '封面解密任务必须下发裸字节描述符（走 worker）',
      );
    } finally {
      await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
    }
  });
});

test('#759 decodeImage：worker 基础设施故障 ⇒ RSS 回落宿主 L1，结果不出错', async () => {
  await withImageWorkerOn(async () => {
    const boom = Object.assign(new Error('sandbox worker 意外退出'), { __yueduWorkerInfra: true });
    const engine = new RssEngine();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const rule = compile({ coverDecodeJs: 'result.readAllBytes()' });
    const ctx = makeCtx(makeHttp({}, []));
    (ctx as unknown as { sandbox: unknown }).sandbox = { __yueduWorkerPool: true, async eval() { throw boom; } };
    const out = await engine.decodeImage(rule, { url: 'https://img.test/w2.jpg', bytes, isCover: true }, ctx);
    assert.ok(out, '必须回落成功，不能返回 null');
    assert.deepEqual(Buffer.from(out), Buffer.from(bytes));
  });
});

test('#434 decodeImage：未声明 coverDecodeJs / 脚本抛错 / 返回字符串 ⇒ null（回传原图）', async () => {
  const engine = new RssEngine();
  const bytes = new Uint8Array([1, 2, 3]);
  const mkHttp = () => makeCtx(makeHttp({}, []));
  assert.equal(await engine.decodeImage(compile({}), { url: 'https://img.test/b.jpg', bytes }, mkHttp()), null);
  assert.equal(
    await engine.decodeImage(compile({ coverDecodeJs: 'throw new Error("boom")' }), { url: 'https://img.test/c.jpg', bytes }, mkHttp()),
    null,
  );
  assert.equal(
    await engine.decodeImage(compile({ coverDecodeJs: '"我不是字节"' }), { url: 'https://img.test/d.jpg', bytes }, mkHttp()),
    null,
  );
});

// ---------------------------------------------------------------------------
// `#438` 91吃瓜-视频：正文规则写法（用户拍板：**不支持** `html.` 这种非常规前缀）
//   · `html.//…` 非规则模式（上游 jsoup 简写只有 children/class/tag/id/text）⇒ 落 CSS ⇒ 恒空；
//     本仓**不**为它做别名兼容（源侧自行改正）。
//   · XPath（`//…`）默认只取**文本** ⇒ 标签被丢，这才是「正文不带标签」的原因（**不是**净化）；
//     要带标签请用 **CSS + `@html`**（`//…@html` 在 XPath 上不被接受、上游语料 0 例）。
// ---------------------------------------------------------------------------

const CG91_ART = `<html><body><div class="post-content">
<blockquote><p>91吃瓜最新地址</p></blockquote>
<p>正文甲</p><p>正文乙</p>
<blockquote><p>免责声明</p></blockquote>
</div></body></html>`;

test('#438 content：`html.//…` 不是规则模式 ⇒ 恒空（不做别名）；带标签要走 CSS `@html`', async () => {
  const mk = async (rc: string): Promise<string> => {
    const c = await new RssEngine().content(
      compile({ ruleContent: rc, type: 0 }),
      { action: 'content', id: JSON.stringify({ title: 'T', link: 'https://cg.test/archives/1/' }) },
      makeCtx(makeHttp({ '/archives/1/': CG91_ART }, [])),
    );
    return String(c.html ?? '');
  };
  // ① 非常规前缀：按 CSS 解析 `select("html.//…")` ⇒ 空（用户拍板不做兼容）
  assert.equal(await mk('html.//blockquote/following-sibling::*[following-sibling::blockquote]'), '');
  // ② XPath 无后缀 ⇒ 只拿到文本（标签被丢 —— 「正文不带标签」的真因，与净化无关）
  const textOnly = await mk('//blockquote/following-sibling::*[following-sibling::blockquote]');
  assert.match(textOnly, /正文甲/, `实得 ${JSON.stringify(textOnly)}`);
  assert.ok(!/<p>|<strong|<img/i.test(textOnly), 'XPath 默认取文本 ⇒ 不应含标签');
  // ③ 规则后端要带标签：CSS + `@html`（本仓与上游一致的能力面）
  const withTags = await mk('.post-content@html');
  assert.match(withTags, /<p>正文甲<\/p>/, `CSS @html 必须带标签，实得 ${JSON.stringify(withTags.slice(0, 120))}`);
});

test('#438 ruleImage 返回 data:image/… 时原样保留（不得当相对地址补全）', async () => {
  const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const rule = compile({
    ruleArticles: '.list li',
    ruleTitle: 'a@title',
    ruleLink: 'a@href',
    ruleImage: '@js:"data:image/jpeg;base64,/9j/4AAQSkZJRg=="',
  });
  const env = makeRssEnv(makeCtx(makeHttp({}, [])), rule, 'https://cg.test');
  const { articles } = await parseRssByRule(LIST_HTML, 'https://cg.test/feed', rule, env, '订阅');
  assert.equal(articles[0]!.image, dataUrl, `data: 必须原样；实得 ${articles[0]!.image}`);
});
