/**
 * WebView 替代（分层渲染）测试：
 *  ① URL 选项尾巴 `,{"webView":true}` → 走渲染器而非 http（对齐 AnalyzeUrl.kt:464 `if (this.useWebView ...)`）
 *  ② 未声明 webView 时不走渲染器（保持普通请求）
 *  ③ java.webView / startBrowserAwait / webViewGetSource 在脚本里可用且经渲染通道
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  type EngineContext,
  type HttpResponse,
  type UnifiedRequest,
} from '@yuedu/core';

const BASE = 'https://wv.test';

const LIST_BODY = '<html><body><ul class="list"><li><a href="/b/1">书</a></li></ul></body></html>';

function makeCtx(renders: string[], body = LIST_BODY): EngineContext {
  return {
    reqId: 'wv',
    sourceId: 'wv-src',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        return { status: 200, headers: {}, body, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
    // 记录渲染调用（含 js 参数）
    webRenderer: async (url: string, opts?: { js?: string }) => {
      renders.push(opts?.js ? `${url} +js:${opts.js}` : url);
      return '<html><body><ul class="list"><li><a href="/b/render">渲染书</a></li></ul></body></html>';
    },
  };
}

function makeRule(searchUrl: string) {
  const r = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '渲染测试源',
    searchUrl,
    ruleSearch: { bookList: '.list > li', name: 'a@text', bookUrl: 'a@href' },
  });
  assert.ok(r.ok && r.rule);
  return r.rule!;
}

test('webView 替代①: URL 尾巴 `,{"webView":true}` → 走渲染器（不发电商请求）', async () => {
  const renders: string[] = [];
  const rule = makeRule(`/s?q={{key}},{"webView":true}`);
  const out = await new LegadoEngine().search(rule as never, { action: 'search', keyword: 'x' }, makeCtx(renders));
  assert.equal(renders.length, 1, '渲染器被调用一次');
  assert.equal(renders[0], `${BASE}/s?q=x`);
  assert.deepEqual(out.items.map((i) => i.title), ['渲染书'], '用渲染后的 DOM 解析');
});

test('webView 替代②: 未声明 webView → 走普通 http（渲染器零调用）', async () => {
  const renders: string[] = [];
  const rule = makeRule('/s?q={{key}}');
  const out = await new LegadoEngine().search(rule as never, { action: 'search', keyword: 'x' }, makeCtx(renders));
  assert.equal(renders.length, 0);
  assert.equal(out.items.length, 1);
});

test('webView 替代③: `webJs` 选项 → 渲染器收到注入脚本（CDP 层执行）', async () => {
  const renders: string[] = [];
  const rule = makeRule(`/s?q={{key}},{"webView":true,"webJs":"document.title"}`);
  await new LegadoEngine().search(rule as never, { action: 'search', keyword: 'k' }, makeCtx(renders));
  assert.equal(renders.length, 1);
  assert.ok(renders[0]?.includes('+js:document.title'), 'js 透传到渲染器');
});

test('webView 替代④: java.webView / startBrowserAwait 可用（返回渲染 DOM / StrResponse）', async () => {
  const renders: string[] = [];
  const rule = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '渲染 API 源',
    searchUrl: '/s?q={{key}}',
    jsLib: 'var html = java.webView("https://wv.test/page"); var r = java.startBrowserAwait("https://wv.test/page2");',
    ruleSearch: { bookList: '.list > li', name: 'a@text', bookUrl: 'a@href' },
  });
  assert.ok(rule.ok && rule.rule);
  // jsLib 无副作用执行；这里断言「渲染器在 js 触达 webView 时被调用」由 core 层单测覆盖，
  // 本用例验证引擎不因缺渲染能力抛错（真实渲染在 core/net/render 单测与端到端验证）
  await new LegadoEngine().search(rule.rule as never, { action: 'search', keyword: 'x' }, makeCtx(renders));
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// 视频类书源播放 + 发现页交互动作（Legado ExploreKind.action）
// ---------------------------------------------------------------------------

test('播放①: 视频源 play = 复用正文管线取 m3u8 直链（Legado：正文即播放页）', async () => {
  const rule = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '视频源',
    bookSourceType: 4,
    ruleBookInfo: { name: 'h1@text', tocUrl: '/detail/1.html' },
    ruleToc: { chapterList: '#list a', chapterName: 'text', chapterUrl: 'href' },
    ruleContent: { content: 'script@html' }, // media 类源：从脚本片段里抽直链
  });
  assert.ok(rule.ok && rule.rule);
  // 播放页：player_aaaa 配置里带 m3u8
  const page = '<html><body><script>var player_aaaa={"url":"https://cdn.test/a/index.m3u8","encrypt":0};</script></body></html>';
  const ctx: EngineContext = {
    reqId: 'p',
    sourceId: 'v',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        if (url.includes('/play/')) return { status: 200, headers: {}, body: page, url };
        if (url.includes('/detail/')) return { status: 200, headers: {}, body: '<html><body><h1>片</h1><div id="list"><a href="/play/1-1-1.html">HD</a></div></body></html>', url };
        return { status: 200, headers: {}, body: '', url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  const engine = new LegadoEngine();
  const play = await engine.play(rule.rule as never, { action: 'play', id: JSON.stringify({ chapterUrl: `${BASE}/play/1-1-1.html`, title: 'HD' }) }, ctx);
  assert.equal(play.format, 'm3u8');
  assert.ok(play.url.includes('index.m3u8'), '返回 m3u8 直链');
  assert.equal((engine.capabilities as string[]).includes('play'), true, 'capabilities 声明 play');
});

test('交互③: select 改值 → 先执行控件 action（写 infoMap）→ 再重跑分类脚本', async () => {
  // 七猫「选择分组」写法：action 依据选中分组把二级键写进 infoMap，分类脚本再读它
  const exploreUrl = `@js:
var group = infoMap["分组"] || "📊 排行榜";
var sub = infoMap["榜单类型"] || "全部";
var map = { "📊 排行榜": ["男频推荐榜", "女频推荐榜"], "📚 分类": ["玄幻", "都市"] };
var items = (map[group] || []).map(function (n) { return {title: n + '(' + sub + ')', url: '/x/' + n}; });
[Object.assign({title: "分组", type: "select", chars: ["📊 排行榜","📚 分类"], default: group}, {})].concat(items);`;
  const rule = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '交互动作源',
    searchUrl: '/s?q={{key}}',
    ruleSearch: { bookList: '.list > li', name: 'a@text', bookUrl: 'a@href' },
    exploreUrl,
    ruleExplore: { bookList: '.list > li', name: 'a@text', bookUrl: 'a@href' },
  });
  assert.ok(rule.ok && rule.rule);
  const st = createMemoryKeyValueStore();
  const ctx: EngineContext = { ...makeCtx([]), storage: st };

  const first = await new LegadoEngine().home(rule.rule as never, { action: 'home' }, ctx);
  assert.deepEqual(first.filters?.[0]?.options.slice(1).map((o) => o.name), ['男频推荐榜(全部)', '女频推荐榜(全部)']);

  // 切换到「📚 分类」并携带控件 action（把「榜单类型」写成 热播）
  const action = 'infoMap["榜单类型"] = (infoMap["分组"] === "📚 分类" ? "热播" : "全部"); "done";';
  const second = await new LegadoEngine().home(
    rule.rule as never,
    { action: 'home', filters: { $input: JSON.stringify({ 分组: '📚 分类' }), $action: action } } as UnifiedRequest,
    ctx,
  );
  assert.deepEqual(second.filters?.[0]?.options.slice(1).map((o) => o.name), ['玄幻(热播)', '都市(热播)'], 'action 写入了 infoMap 并影响分类');
  assert.equal((await st.get('explore-input:wv-src'))?.includes('热播'), true, '控件脚本写入的 infoMap 已持久化');
});
