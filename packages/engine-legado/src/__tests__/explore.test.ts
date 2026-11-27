/**
 * exploreKinds（发现分类）测试 —— 对齐 Legado BookSourceExtensions.exploreKinds：
 *  1. 多行「名称::URL」→ home 返回 filters（key='explore'）
 *  2. JSON 数组 [{title,url}] 形态
 *  3. category 用 filters['explore'] 选中的 URL 列书
 *  4. @js: 构造分类列表
 *  5. 单条 URL 模板保持旧行为（直接列书，不返回 filters）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LegadoEngine } from '../index';
import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  type EngineContext,
  type HttpClient,
  type JsSandboxPool,
  type UnifiedRequest,
  EXPLORE_INPUT_KEY,
  EXPLORE_ACTION_KEY,
} from '@yuedu/core';

const noopSandbox: JsSandboxPool = { async eval() { throw new Error('no sandbox'); } };

/** mock http：按 URL 子串返回预设响应 */
function mockHttp(map: Record<string, { body: string; status?: number }>): HttpClient {
  return {
    async request(url: string) {
      for (const key of Object.keys(map)) {
        if (url.includes(key)) {
          return { status: map[key]!.status ?? 200, headers: {}, body: map[key]!.body, url };
        }
      }
      throw new Error(`no mock for ${url}`);
    },
  };
}

function makeCtx(http: HttpClient): EngineContext {
  return {
    reqId: 't', sourceId: 'src', signal: new AbortController().signal,
    http, sandbox: noopSandbox, trace: createTraceSink(),
    variables: createVariableStore(), storage: createMemoryKeyValueStore(),
  };
}

const engine = new LegadoEngine();

function compile(raw: Record<string, unknown>) {
  const r = engine.compile(raw);
  assert.ok(r.ok && r.rule !== undefined, 'compile 应通过');
  return r.rule!;
}

const LIST_HTML = `<html><body><ul class="list">
  <li><h3><a href="/b/1">武侠小说A</a></h3><span class="author">作者甲</span></li>
  <li><h3><a href="/b/2">武侠小说B</a></h3><span class="author">作者乙</span></li>
</ul></body></html>`;

const RAW_BASE = {
  bookSourceUrl: 'https://x.com',
  bookSourceName: '测试源',
  ruleSearch: { bookList: '.list > li', name: 'h3 > a@text', bookUrl: 'h3 > a@href', author: '.author@text' },
  ruleExplore: { bookList: '.list > li', name: 'h3 > a@text', bookUrl: 'h3 > a@href', author: '.author@text' },
};

test('exploreKinds: 多行「名称::URL」→ home 返回 filters', async () => {
  const rule = compile({
    ...RAW_BASE,
    exploreUrl: '玄幻::/xh/{{page}}.html\n&&都市::/ds/{{page}}.html',
  });
  const http = mockHttp({});
  const r = await engine.home(rule, { action: 'home', page: 1 }, makeCtx(http));
  assert.equal(r.items.length, 0);
  assert.equal(r.filters?.length, 1);
  assert.equal(r.filters?.[0]?.key, 'explore');
  assert.deepEqual(r.filters?.[0]?.options.map((o) => o.name), ['玄幻', '都市']);
  assert.deepEqual(r.filters?.[0]?.options.map((o) => o.value), ['/xh/{{page}}.html', '/ds/{{page}}.html']);
});

/**
 * `#405②` `{,...}` 可选段（非 Legado 语法，源作者约定；实证 🎨咚漫 `exploreUrl`）：
 * 分类值 `https://x.com/genre{,/error.html}#LOVE` 的字面量形态站点会 404；
 * 本仓剥离该段取主 URL ⇒ 请求必须打到 `https://x.com/genre`（不含可选段）。
 */
test('#405② category：explore 值含 `{,...}` 可选段 ⇒ 请求剥离该段', async () => {
  const seen: string[] = [];
  const http: HttpClient = {
    async request(url: string) {
      seen.push(url);
      return { status: 200, headers: {}, body: LIST_HTML, url };
    },
  };
  const rule = compile({ ...RAW_BASE, exploreUrl: '分类::https://x.com/genre{,/error.html}#LOVE' });
  const r = await engine.category(
    rule,
    { action: 'category', filters: { explore: 'https://x.com/genre{,/error.html}#LOVE' } } as UnifiedRequest,
    makeCtx(http),
  );
  assert.ok(seen.length > 0, '必须发出请求');
  assert.ok(seen.every((u) => !u.includes('{,')), `请求 URL 不得含可选段：${JSON.stringify(seen)}`);
  assert.ok(seen.some((u) => u.startsWith('https://x.com/genre')), `主 URL 必须保留：${JSON.stringify(seen)}`);
  assert.equal(r.items.length, 2);
});

test('exploreKinds: JSON 数组形态', async () => {
  const rule = compile({
    ...RAW_BASE,
    exploreUrl: '[{"title":"全部","url":"/all/1.html"},{"title":"完本","url":"/finish/1.html"}]',
  });
  const r = await engine.home(rule, { action: 'home' }, makeCtx(mockHttp({})));
  assert.equal(r.filters?.[0]?.options.length, 2);
  assert.equal(r.filters?.[0]?.options[0]?.name, '全部');
});

test('exploreKinds: category 用 filters[explore] 选中的 URL 列书', async () => {
  const rule = compile({
    ...RAW_BASE,
    exploreUrl: '玄幻::/xh/{{page}}.html&&都市::/ds/{{page}}.html',
  });
  const http = mockHttp({ '/xh/': { body: LIST_HTML } });
  const r = await engine.category(rule, { action: 'category', filters: { explore: '/xh/{{page}}.html' } } as UnifiedRequest, makeCtx(http));
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0]?.title, '武侠小说A');
  assert.equal((r.items[0]!.payload as { bookUrl?: string }).bookUrl, 'https://x.com/b/1'); // Legado 语义：href 绝对化
});

test('exploreKinds: @js: 构造分类列表（单分类也渲染分类条，不自动加载）', async () => {
  const rule = compile({
    ...RAW_BASE,
    exploreUrl: '@js:\nvar kinds = [{"title":"JS分类","url":"/js/1.html"}];\nJSON.stringify(kinds);',
  });
  const http = mockHttp({ '/js/1.html': { body: LIST_HTML } });
  const r = await engine.home(rule, { action: 'home' }, makeCtx(http));
  // 对齐 Legado ExploreAdapter.upKindList：kinds 总是渲染（1 个也是可点分类），点击才加载内容
  assert.equal(r.items.length, 0, '不自动加载内容');
  assert.equal(r.filters?.[0]?.options.length, 1);
  assert.equal(r.filters?.[0]?.options[0]?.name, 'JS分类');
  assert.equal(r.filters?.[0]?.options[0]?.value, '/js/1.html');
});

test('exploreKinds: 单元素数组（520diandu 真实格式）也返回分类条', async () => {
  const rule = compile({
    ...RAW_BASE,
    exploreUrl: JSON.stringify([
      {
        title: '📚全部书籍',
        url: 'https://api.x.com/all?page={{page}}&cv=134',
        style: { layout_flexBasisPercent: 1, layout_flexGrow: 1 },
      },
    ]),
  });
  const r = await engine.home(rule, { action: 'home' }, makeCtx(mockHttp({})));
  assert.equal(r.items.length, 0);
  assert.equal(r.filters?.[0]?.options.length, 1, '单个分类也渲染分类条');
  assert.equal(r.filters?.[0]?.options[0]?.name, '📚全部书籍');
  assert.deepEqual(r.filters?.[0]?.options[0]?.layout, { flexBasisPercent: 1, flexGrow: 1 });
});

test('exploreKinds: source.key 是 bookSourceUrl（Legado JavaBean 属性视图，51漫画真实用法）', async () => {
  // 51漫画 exploreUrl: `java.ajax(source.key + '/category')`。
  // 早期 source 桩只给了 getKey() 方法、没有 key 属性 → 拼出 `undefined/category`
  // → JSON.parse 空串/undefined.html() 炸「Cannot read properties of undefined」，
  // 26 个源（含 51漫画）发现页分类整片失败。
  const rule = compile({
    ...RAW_BASE,
    exploreUrl: "@js:\nJSON.stringify([{title: 'base=' + source.key, url: '/cat/{{page}}.html'}]);",
  });
  const r = await engine.home(rule, { action: 'home' }, makeCtx(mockHttp({})));
  assert.equal(r.filters?.[0]?.options[0]?.name, 'base=https://x.com');
});

test('exploreKinds: source.getKey() 与 source.key 等价', async () => {
  const rule = compile({
    ...RAW_BASE,
    exploreUrl: "@js:\nJSON.stringify([{title: 'a=' + source.getKey() + '|b=' + source.key, url: '/c/{{page}}.html'}]);",
  });
  const r = await engine.home(rule, { action: 'home' }, makeCtx(mockHttp({})));
  assert.equal(r.filters?.[0]?.options[0]?.name, 'a=https://x.com|b=https://x.com');
});

test('exploreKinds: 单条 URL 模板保持旧行为（直接列书，无 filters）', async () => {
  const rule = compile({
    ...RAW_BASE,
    exploreUrl: '/explore/{{page}}.html',
  });
  const http = mockHttp({ '/explore/': { body: LIST_HTML } });
  const r = await engine.home(rule, { action: 'home', page: 1 }, makeCtx(http));
  assert.equal(r.items.length, 2);
  assert.equal(r.filters, undefined);
});

test('exploreKinds: JS 对象字面量数组（单引号 + style 布局 + 空 url 分组头）—— yydsmh 真实格式', async () => {
  // 用户上报的真实格式：脚本返回数组字面量，元素用单引号、含 style 布局信息，
  // 首个元素 url:"" 是分组大标题（layout_flexBasisPercent=1 → 整行）
  const exploreUrl = `@js:
[
{"title":"𓆡𓆝𓆟地ོ区ོ𓆟𓆜𓆞","url":"","style":{"layout_flexGrow":1,"layout_flexBasisPercent":1}},
{"title":"🥣日漫","url":'https://www.yydsmh.com/api/comic/index/lists,{"body":"area=9&tags=日漫&full=3&page={{page}}","method":"POST"}',"style":{"layout_flexGrow":1,"layout_flexBasisPercent":0.25}},
{"title":"🥣国漫","url":'https://www.yydsmh.com/api/comic/index/lists,{"body":"area=9&tags=国漫&full=3&page={{page}}","method":"POST"}',"style":{"layout_flexGrow":1,"layout_flexBasisPercent":0.25}}
]`;
  const rule = compile({ ...RAW_BASE, exploreUrl });
  const r = await engine.home(rule, { action: 'home' }, makeCtx(mockHttp({})));
  const opts = r.filters?.[0]?.options ?? [];
  assert.equal(opts.length, 3, '三个分类项都识别（含分组头）');
  // 分组头：不可点 + 整行布局
  assert.equal(opts[0]?.name, '𓆡𓆝𓆟地ོ区ོ𓆟𓆜𓆞');
  assert.equal(opts[0]?.header, true, '空 url 项标记为分组标题');
  assert.equal(opts[0]?.value, '');
  assert.deepEqual(opts[0]?.layout, { flexGrow: 1, flexBasisPercent: 1 });
  // 分类项：URL 含 ,{options} 尾巴（单引号包裹）完整保留 + 0.25 布局
  assert.equal(opts[1]?.header, undefined);
  assert.ok(opts[1]?.value.includes('tags=日漫'), '单引号 URL 内容保留');
  assert.ok(opts[1]?.value.startsWith('https://www.yydsmh.com/api/comic/index/lists,{"body"'), 'options 尾巴保留');
  assert.deepEqual(opts[1]?.layout, { flexGrow: 1, flexBasisPercent: 0.25 });
});

test('exploreKinds: JS 直接 return 数组（不 stringify）也能识别', async () => {
  const rule = compile({
    ...RAW_BASE,
    exploreUrl: `@js:
var arr = [];
arr.push({title:'分组', url:''});
arr.push({title:'分类A', url:'/a/{{page}}.html'});
arr;`,
  });
  const r = await engine.home(rule, { action: 'home' }, makeCtx(mockHttp({})));
  const opts = r.filters?.[0]?.options ?? [];
  assert.deepEqual(opts.map((o) => o.name), ['分组', '分类A']);
  assert.equal(opts[0]?.header, true);
  assert.equal(opts[1]?.value, '/a/{{page}}.html');
});

test('exploreKinds: 严格 JSON 数组 + style/type 透传（type:text 也视为分组头）', async () => {
  const rule = compile({
    ...RAW_BASE,
    exploreUrl: JSON.stringify([
      { title: '地区', url: '', type: 'text', style: { layout_flexBasisPercent: 1 } },
      { title: '日漫', url: '/jp/{{page}}.html', style: { layout_flexBasisPercent: 0.25 } },
      { title: '美漫', url: '/us/{{page}}.html', style: { layout_flexBasisPercent: 0.25 } },
    ]),
  });
  const r = await engine.home(rule, { action: 'home' }, makeCtx(mockHttp({})));
  const opts = r.filters?.[0]?.options ?? [];
  // 交互型（type=text）不是分组头：交由控件渲染（header 仅在「无 url 且非交互」时为 true）
  assert.equal(opts[0]?.header, undefined);
  assert.equal(opts[0]?.kind, 'text');
  assert.deepEqual(opts[1]?.layout, { flexBasisPercent: 0.25 });
});

test('exploreKinds: 分组头 + 单分类的 array 形态，category 仍可按 value 列书', async () => {
  const urls: string[] = [];
  const http: HttpClient = {
    async request(url: string) {
      urls.push(url);
      return { status: 200, headers: {}, body: LIST_HTML, url };
    },
  };
  const rule = compile({
    ...RAW_BASE,
    exploreUrl: JSON.stringify([
      { title: '地区', url: '', style: { layout_flexBasisPercent: 1 } },
      { title: '日漫', url: 'https://x.com/jp/{{page}}.html' },
    ]),
  });
  const r = await engine.category(rule, { action: 'category', filters: { explore: 'https://x.com/jp/{{page}}.html' } } as UnifiedRequest, makeCtx(http));
  assert.equal(urls[0], 'https://x.com/jp/1.html', '{{page}} 插值 + 发请求');
  assert.equal(r.items.length, 2);
});

test('源开关: enabledExplore=false 的源 home/category 返回空（Legado BookSource.enabledExplore）', async () => {
  const rule = compile({
    ...RAW_BASE,
    enabledExplore: false,
    searchUrl: '/s?q={{key}}',
    exploreUrl: '玄幻::/xh/{{page}}.html&&都市::/ds/{{page}}.html',
  });
  const http = mockHttp({});
  const home = await engine.home(rule, { action: 'home' }, makeCtx(http));
  assert.equal(home.items.length, 0);
  assert.equal(home.filters, undefined, '禁用发现的源不返回分类');
  const cat = await engine.category(rule, { action: 'category', filters: { explore: '/xh/{{page}}.html' } } as UnifiedRequest, makeCtx(http));
  assert.equal(cat.items.length, 0);
  // 搜索不受影响（Legado 只有 enabled / enabledExplore 两个开关）
  const search = await engine.search(rule, { action: 'search', keyword: '武侠' }, makeCtx(mockHttp({ s: { body: LIST_HTML } })));
  assert.equal(search.items.length, 2, '搜索仍可用');
});

// ---------------------------------------------------------------------------
// 发现页交互输入态（Legado infoMap）——select/toggle/text/button
// ---------------------------------------------------------------------------

test('交互①: select 的 chars/default 透传 + 初值按源播种（下次脚本可读 infoMap）', async () => {
  // 网阅小说/电源先生真实写法：脚本读 infoMap["频道"] 决定返回哪组分类
  const exploreUrl = `@js:
var mainCat = infoMap["频道"] || "小说排行";
var cats = {
  "小说排行": [["总人气榜","/rank1.html"]],
  "男生频道": [["玄幻奇幻","/list-t-3.html?page={{page}}"]]
};
var result = [{
  title: "频道", type: "select",
  chars: ["小说排行","男生频道"],
  default: mainCat,
  action: "java.refreshExplore()",
  style: {layout_flexGrow: 1, layout_flexBasisPercent: 1}
}];
(cats[mainCat] || []).forEach(function (c) { result.push({title: c[0], url: c[1]}); });
result;`;
  const rule = compile({ ...RAW_BASE, exploreUrl });
  const st = createMemoryKeyValueStore();
  const ctx: EngineContext = { ...makeCtx(mockHttp({})), storage: st };

  // ① 首访：无持久输入 → 脚本走自身兜底「小说排行」，并把 default 播种进存储
  const first = await engine.home(rule, { action: 'home' }, ctx);
  const opts1 = first.filters?.[0]?.options ?? [];
  assert.equal(opts1[0]?.kind, 'select');
  assert.deepEqual(opts1[0]?.chars, ['小说排行', '男生频道']);
  assert.equal(opts1[0]?.default, '小说排行');
  assert.equal(opts1[0]?.action, 'java.refreshExplore()');
  assert.deepEqual(opts1.map((o) => o.name), ['频道', '总人气榜'], '首访分类 = 兜底频道');
  assert.equal((await st.get('explore-input:src')) !== null, true, '初值已持久化');

  // ② 用户选「男生频道」→ filters[$input] 回传 → 脚本读到 infoMap["频道"] → 分类列表整体切换
  const second = await engine.home(
    rule,
    { action: 'home', filters: { [EXPLORE_INPUT_KEY]: JSON.stringify({ 频道: '男生频道' }) } } as UnifiedRequest,
    ctx,
  );
  const opts2 = second.filters?.[0]?.options ?? [];
  assert.deepEqual(opts2.map((o) => o.name), ['频道', '玄幻奇幻'], '频道切换后分类随之变化');
  assert.equal(opts2[0]?.default, '男生频道', 'default 跟随持久输入');
  assert.equal(opts2[1]?.value, '/list-t-3.html?page={{page}}');

  // ③ 输入态跨请求持久（新 ctx 同 storage = 同一源）
  const third = await engine.home(rule, { action: 'home' }, ctx);
  assert.deepEqual((third.filters?.[0]?.options ?? []).map((o) => o.name), ['频道', '玄幻奇幻']);
});

test('交互②: text/button 的 action 透传（搜索框 + 搜索按钮）', async () => {
  const exploreUrl = `@js:
[{
  title: "☃关键词💭：书名/作者", type: "text",
  style: {layout_flexGrow: 1, layout_flexBasisPercent: 0.6}
}, {
  title: "🔍搜索", type: "button",
  action: "java.searchBook(infoMap['☃关键词💭：书名/作者'] || '', source.bookSourceName)",
  style: {layout_flexGrow: 1, layout_flexBasisPercent: -1}
}, {
  title: "全部", url: "/all/{{page}}.html"
}];`;
  const rule = compile({ ...RAW_BASE, exploreUrl });
  const r = await engine.home(rule, { action: 'home' }, makeCtx(mockHttp({})));
  const opts = r.filters?.[0]?.options ?? [];
  assert.equal(opts.length, 3);
  assert.equal(opts[0]?.kind, 'text');
  assert.equal(opts[0]?.header, undefined, '交互控件不是分组标题（由控件渲染）');
  assert.equal(opts[1]?.kind, 'button');
  assert.ok(opts[1]?.action?.includes('java.searchBook'), 'button action 透传');
  assert.equal(opts[2]?.value, '/all/{{page}}.html');
});

test('交互④: 源变量（source.getVariable/setVariable）按源持久化 —— 七猫「选择分组」写法', async () => {
  // 七猫的真实机制：分组存在 **源变量** 里（不是 infoMap），action 写 source.setVariable，
  // 分类脚本再读 source.getVariable() 决定返回哪组分类。此前源变量只在单请求内存里 → 切了没反应。
  const exploreUrl = `@js:
var config = {};
try { var rawV = source.getVariable(); if (rawV && rawV !== '{}') config = JSON.parse(rawV); } catch (e) {}
var group = config.exploreGroup || '排行榜';
var map = { '排行榜': ['男频推荐榜'], '分类': ['现代言情', '总裁豪门'] };
var items = (map[group] || []).map(function (n) { return { title: n, url: '/x/' + n }; });
[{ title: '📁 选择分组', type: 'select', chars: ['📊 排行榜', '📚 分类'],
   default: (group === '分类' ? '📚 分类' : '📊 排行榜'),
   action: "(function(){ var c={}; try{ c=JSON.parse(source.getVariable()||'{}'); }catch(e){ c={}; } var raw=infoMap['📁 选择分组']||'📊 排行榜'; c.exploreGroup = (raw==='📚 分类'?'分类':'排行榜'); source.setVariable(JSON.stringify(c)); java.refreshExplore(); })()" }].concat(items);`;
  const rule = compile({
    ...RAW_BASE,
    searchUrl: '/s?q={{key}}',
    exploreUrl,
  });
  const st = createMemoryKeyValueStore();
  const ctx: EngineContext = { ...makeCtx(mockHttp({})), storage: st };

  const first = await engine.home(rule, { action: 'home' }, ctx);
  const cats1 = (first.filters?.[0]?.options ?? []).filter((o) => !o.kind && !o.header).map((o) => o.name);
  assert.deepEqual(cats1, ['男频推荐榜'], '默认分组 = 排行榜');
  const sel1 = (first.filters?.[0]?.options ?? []).find((o) => o.kind === 'select');
  assert.equal(sel1?.default, '📊 排行榜');

  // 切到 📚 分类：携带控件 action → 引擎执行 → 写源变量 → 重跑分类脚本
  const second = await engine.home(
    rule,
    {
      action: 'home',
      filters: {
        [EXPLORE_INPUT_KEY]: JSON.stringify({ '📁 选择分组': '📚 分类' }),
        [EXPLORE_ACTION_KEY]: String(sel1?.action),
      },
    } as UnifiedRequest,
    ctx,
  );
  const cats2 = (second.filters?.[0]?.options ?? []).filter((o) => !o.kind && !o.header).map((o) => o.name);
  assert.deepEqual(cats2, ['现代言情', '总裁豪门'], '切换分组后分类列表随之变化');
  assert.equal((second.filters?.[0]?.options ?? []).find((o) => o.kind === 'select')?.default, '📚 分类', 'default 跟随源变量');
  assert.equal((await st.get('source-var:src'))?.includes('分类'), true, '源变量已持久化');

  // ③ 新请求（同 storage）仍读到持久化的分组
  const third = await engine.home(rule, { action: 'home' }, ctx);
  assert.deepEqual(
    (third.filters?.[0]?.options ?? []).filter((o) => !o.kind && !o.header).map((o) => o.name),
    ['现代言情', '总裁豪门'],
    '源变量跨请求持久',
  );
});

test('空结果线索：站点返回非 HTML 短文本时透出 hint（区分「源失效」与「解析不匹配」）', async () => {
  // 七猫官方 API 现状：接口对未登录/非法签名返回 {"Status":"Unauthorized"}，
  // 若不透出，用户只看到静默空卡片、无法判断原因。
  const rule = compile({
    ...RAW_BASE,
    searchUrl: '/api/search?q={{key}}',
    ruleSearch: { bookList: '$.data.books', name: 'title', bookUrl: 'id' },
  });
  const r = await engine.search(
    rule,
    { action: 'search', keyword: 'x' },
    makeCtx(mockHttp({ '/api/search': { body: '{"Status":"Unauthorized"}' } })),
  );
  assert.equal(r.items.length, 0);
  assert.match(String(r.hint), /Unauthorized/, 'hint 带出站点原文');

  // 正常（大）HTML 页面 → 不猜原因（多为选择器不匹配）
  const big = '<html><body>' + '<div class="x">no match</div>'.repeat(40) + '</body></html>';
  const r2 = await engine.search(rule, { action: 'search', keyword: 'x' }, makeCtx(mockHttp({ '/api/search': { body: big } })));
  assert.equal(r2.items.length, 0);
  assert.equal(r2.hint, undefined, '像 HTML 的响应不透出 hint');

  // 有结果 → 无 hint
  const r3 = await engine.search(
    rule,
    { action: 'search', keyword: 'x' },
    makeCtx(mockHttp({ '/api/search': { body: '{"data":{"books":[{"id":"/b/1","title":"书一"}]}}' } })),
  );
  assert.equal(r3.items.length, 1);
  assert.equal(r3.hint, undefined);
});

test('exploreKinds: Rhino 语法 `[a,b] =>`（裸数组解构形参）在 V8 下也能跑出分类', async () => {
  // 实测番茄系聚合源写法：`.map([title, id] => {...})`。
  // Rhino 接受、V8 抛 Malformed arrow function parameter list → 整篇脚本语法错 → 分类空。
  // 修复点：core/selector/js.ts normalizeRhinoSyntax 预处理补括号。
  const rule = compile({
    ...RAW_BASE,
    exploreUrl: `@js:
let out = [];
push = (t, u) => out.push({ title: t, url: u });
[["男频","1"],["女频","0"]].map([title, id] => {
  push('❤️' + title + '❤️', null);
  [["推荐","10"],["完结","11"]].map([t2, u2] => {
    push(t2, '/list/' + id + '/' + u2 + '/{{page}}.html');
  });
});
JSON.stringify(out);`,
  });
  const r = await engine.home(rule, { action: 'home' }, makeCtx(mockHttp({})));
  const opts = r.filters?.[0]?.options ?? [];
  assert.deepEqual(opts.map((o) => o.name), ['❤️男频❤️', '推荐', '完结', '❤️女频❤️', '推荐', '完结']);
  assert.equal(opts[0]?.header, true, '无 url 的分组头不可点');
  assert.equal(opts[1]?.value, '/list/1/10/{{page}}.html');
});

test('exploreKinds: 脚本报错时返回 ERROR:… 分类（对齐 Legado，不静默空）', async () => {
  const rule = compile({ ...RAW_BASE, exploreUrl: '@js:/nthisIsNotAFunction();' });
  const r = await engine.home(rule, { action: 'home' }, makeCtx(mockHttp({})));
  const opts = r.filters?.[0]?.options ?? [];
  assert.equal(opts.length, 1);
  assert.match(String(opts[0]?.name), /^ERROR:/);
  assert.equal(opts[0]?.kind, 'text', 'ERROR 标签不可点');
});

/**
 * `#640` 用户实测「八叉书库 未加载分类」：
 * `exploreUrl` 是 JSON 数组字面量，但某个 url 模板里带了**真实换行**（`{{ …pjstr}}` 多行脚本）。
 * 裸控制字符在 JSON 字符串里非法 ⇒ `JSON.parse` 抛 `Bad control character`，
 * 退化到 JS 字面量也语法错，再退化到按行切分 ⇒ 每个 kind 都无 url ⇒
 * 引擎把**整段 JSON 文本当 URL** 去请求（`GET /[{"title":…}]` → 404）⇒ 前端「未加载分类」。
 *
 * 上游 `GSON` 的 lenient `JsonReader` 接受字符串内裸控制字符（同一份源在 Legado 能出分类），
 * 所以我们要放宽；**且数组形态解析失败时必须产 `ERROR:` 分类**（对齐上游 onFailure），
 * 绝不能把 JSON 文本当 URL 请求。
 */
test('#640 exploreKinds：JSON 数组里含裸换行的 url 模板也要解析出来（不得当 URL 请求）', async () => {
  const seen: string[] = [];
  const http: HttpClient = {
    async request(url: string) {
      seen.push(url);
      return { status: 200, headers: {}, body: LIST_HTML, url };
    },
  };
  const exploreUrl = `[
{"title":"分类","url":"","style":{"layout_flexBasisPercent":1}},
{"title":"长篇","url":"/booklist1/{{page-1}}.html"},
{"title":"完本小说","url":"/completed/{{
	var pjstr = 'index.html';
	if(page!=1)  pjstr='index_'+page+'.html';
	pjstr}}"}
]`;
  const rule = compile({ ...RAW_BASE, exploreUrl });
  const r = await engine.home(rule, { action: 'home', page: 1 }, makeCtx(http));
  assert.equal(seen.length, 0, `不得把 JSON 文本当 URL 请求：${JSON.stringify(seen)}`);
  assert.deepEqual(r.filters?.[0]?.options.map((o) => o.name), ['分类', '长篇', '完本小说']);
  assert.equal(r.filters?.[0]?.options[0]?.header, true, 'url 为空的第一项是分组标题');
  assert.equal(r.filters?.[0]?.options[2]?.value?.includes('\n'), true, '多行模板原样保留（后续由 {{}} 求值）');
});

test('#640 exploreKinds：数组形态彻底解析不了 ⇒ 产出 ERROR 分类（不静默、不假装 URL）', async () => {
  const seen: string[] = [];
  const http: HttpClient = {
    async request(url: string) {
      seen.push(url);
      return { status: 200, headers: {}, body: LIST_HTML, url };
    },
  };
  const rule = compile({ ...RAW_BASE, exploreUrl: '[{"title":"坏", "url": }]' });
  const r = await engine.home(rule, { action: 'home', page: 1 }, makeCtx(http));
  assert.equal(seen.length, 0, `不得发请求：${JSON.stringify(seen)}`);
  const names = r.filters?.[0]?.options.map((o) => o.name) ?? [];
  assert.equal(names.length, 1);
  assert.match(names[0]!, /^ERROR:/, `应产 ERROR 分类，实际 ${JSON.stringify(names)}`);
});
