/**
 * Phase 0.1 关键回归：**用 jsoup 的脚本也必须进 worker**（而不是被推回 L1）。
 *
 * 背景（本轮实测定位的真因）：
 *   旧版 `createHybridJsEvaluator` 只要代码里出现 DOM API（`.select(` 等）就无条件回 L1，
 *   而 L1 的 `java.ajax` 用 `execFileSync('curl')` **同步阻塞事件循环**。
 *   Legado 源最主流的写法恰恰是 `org.jsoup.Jsoup.parse(java.ajax(u)).select(s)...`
 *   → 语料里 62 个含 java.ajax 的源中 **25 个（40%）**因此被推回 L1。
 *   实测：3 并发 home 墙钟 19.8s，其中 curl 阻塞 18.8s。
 *
 * 修法：worker 也提供 `org.jsoup`（`__yueduJsoup`）—— `select` 经 RPC 回宿主调
 *   `jsoupSelect`（与 L1 **同一份实现**），产出本就是可序列化 POJO，回传无损失。
 *   于是这类脚本进 worker：java.ajax 走异步 RPC，宿主事件循环不再被 curl 卡住。
 *
 * 本测试同时断言「结果正确」与「没有发生 curl 阻塞」——两者缺一不可：
 * 只断言结果的话，路由回 L1 也能过（那正是要防的回归）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { blockSamples, resetBlocks } from '../diag/block-stats';
import { createVariableStore } from '../store';

/** 含「类别列表」JSON 的页面（模拟 51漫画 /category 的真实结构：标记文本在 script 里） */
const PAGE =
  '<html><body><div>hi</div>' +
  '<script id="__dt" type="application/ld+json">{"类别列表":true,"itemListElement":[{"name":"热血","url":"/browser/comic?c=1&page=1"}]}</script>' +
  '</body></html>';

/** 真实语料里的典型写法（来自 51漫画 exploreUrl） */
const CODE = [
  "var html = java.ajax('https://s.test/category');",
  "var list = org.jsoup.Jsoup.parse(html).select('script').toArray();",
  "var hit = list.find(function (e) { return String(e).includes('类别列表'); });",
  'JSON.stringify(JSON.parse(hit.html()).itemListElement);',
].join('\n');

test('jsoup + java.ajax：路由进 worker，结果正确且不发生 curl 阻塞', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const httpCalls: string[] = [];
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async (r) => {
      httpCalls.push(r.url);
      return { status: 200, headers: {}, body: PAGE };
    },
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;

  resetBlocks();
  const out = String(await Promise.resolve(ev(CODE, { baseUrl: 'https://s.test' })));

  // ① 结果正确：jsoup 链式（parse/select/toArray/find/String(e)/html）全通
  assert.ok(out.includes('热血'), `jsoup 链应取出分类：${out}`);
  assert.ok(out.includes('/browser/comic'), `应保留 url 字段：${out}`);

  // ② 走的是宿主注入的 HTTP（异步），不是 L1 的 curl
  assert.deepEqual(httpCalls, ['https://s.test/category'], '宿主 HTTP 应被调用一次');

  // ③ 关键断言：全程没有 curl 阻塞（这是本修复的核心目标）
  const curls = blockSamples().filter((s) => s.kind === 'curl');
  assert.equal(curls.length, 0, `不应发生 curl 阻塞，实际：${JSON.stringify(curls)}`);
  const l1Http = blockSamples().filter((s) => s.kind === 'l1-eval' && s.detail.startsWith('HTTP'));
  assert.equal(l1Http.length, 0, `L1 不应执行含 HTTP 的求值，实际：${JSON.stringify(l1Http)}`);

  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

test('jsoup：select 链式与 attr/text 语义与 L1 一致', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async () => ({ status: 200, headers: {}, body: '' }),
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;

  const code = [
    "var doc = org.jsoup.Jsoup.parse('<div class=\"box\"><a href=\"/x\">甲</a><a href=\"/y\">乙</a></div>');",
    "var as = doc.select('a');",
    "JSON.stringify({ n: as.size(), first: as.first().text(), href: as.attr('href'), all: as.toArray().map(function (e) { return e.text(); }), inner: doc.select('div').first().html() });",
  ].join('\n');

  const out = String(await Promise.resolve(ev(code, { baseUrl: 'https://s.test' })));
  const v = JSON.parse(out) as { n: number; first: string; href: string; all: string[]; inner: string };
  assert.equal(v.n, 2, `size 应为 2：${out}`);
  assert.equal(v.first, '甲', `first().text()：${out}`);
  assert.equal(v.href, '/x', `attr('href')：${out}`);
  assert.deepEqual(v.all, ['甲', '乙'], `toArray().map(text)：${out}`);
  assert.ok(v.inner.includes('<a href="/x">甲</a>'), `innerHTML 应含子元素：${out}`);

  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

// ---------------------------------------------------------------------------
// `#333` 回归锁：jsoup 仿真 API 面 —— Document.selectFirst / Document.body() / Elements.remove() 回写
//
// 真因（次元小镇实测报错）：`doc.selectFirst is not a function`。
// 上游 jsoup 里 **Document extends Element**，所以 `selectFirst` 在「doc 上」和「元素上」都有；
// 本仓 L1（`selector/js.ts` 的 makeOrgStub）与 worker（`sandbox/worker-pool.ts` 的 __yueduJsoup）
// 是**两份实现**（铁律：同一判据写两处必然漂移）⇒ 补方法必须两边同时补，且断言两边一致。
// ---------------------------------------------------------------------------

/** 模拟次元小镇正文页：侧栏 + `.content_left`（脚本要 `selectFirst('.content_left')`） */
const CITY_HTML =
  '<html><body><div class="sidebar">广告位</div><div class="ad">广告位甲</div><div class="ad">广告位乙</div><div class="content_left"><p>正文甲</p><p>正文乙</p></div></body></html>';

/** L1 路径用：HTML 内联（L1 的 java.ajax 走 execFileSync curl，本机不可用，故不带 ajax） */
const CITY_CODE_L1 = [
  "var doc = org.jsoup.Jsoup.parse(" + JSON.stringify(CITY_HTML) + ");",
  "var content = doc.selectFirst('.content_left');",
  "JSON.stringify({ hit: content == null ? null : content.html(), body: doc.body() == null ? null : doc.body().text() });",
].join('\n');

/** worker 路径用：带 java.ajax（保证进 worker，且与真实源写法一致） */
const CITY_CODE_WORKER = [
  "var html = java.ajax('https://s.test/x');",
  "var doc = org.jsoup.Jsoup.parse(html);",
  "var content = doc.selectFirst('.content_left');",
  "JSON.stringify({ hit: content == null ? null : content.html(), body: doc.body() == null ? null : doc.body().text() });",
].join('\n');

const REMOVE_CODE_L1 = [
  "var doc = org.jsoup.Jsoup.parse(" + JSON.stringify(CITY_HTML) + ");",
  "doc.select('.sidebar').remove();",
  "JSON.stringify({ html: doc.html(), again: doc.select('.sidebar').size() });",
].join('\n');

const REMOVE_CODE_WORKER = [
  "var html = java.ajax('https://s.test/x');",
  "var doc = org.jsoup.Jsoup.parse(html);",
  "doc.select('.sidebar').remove();",
  "JSON.stringify({ html: doc.html(), again: doc.select('.sidebar').size() });",
].join('\n');

type CityOut = { hit: string | null; body: string | null };

test('#333 jsoup Document.selectFirst / body()：L1 与 worker 两条路径都可用', async () => {
  // ---- L1（不传 pool ⇒ createHybridJsEvaluator 直接返回 l1）----
  const l1ev = createHybridJsEvaluator({ variables: createVariableStore() }) as (
    code: string,
    bindings: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  const l1out = JSON.parse(String(await Promise.resolve(l1ev(CITY_CODE_L1, {})))) as CityOut;
  assert.ok(l1out.hit && l1out.hit.includes('正文甲'), `L1 selectFirst 应取到正文：${JSON.stringify(l1out)}`);
  assert.ok(l1out.body && l1out.body.includes('正文甲'), `L1 body() 应可用：${JSON.stringify(l1out)}`);

  // ---- worker ----
  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async () => ({ status: 200, headers: {}, body: CITY_HTML }),
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
  const wout = JSON.parse(String(await Promise.resolve(ev(CITY_CODE_WORKER, { baseUrl: 'https://s.test' })))) as CityOut;

  // ★ 对偶断言：两条路径结论必须一致（不一致就是「两边实现漂移」）
  assert.deepEqual(wout, l1out, `worker 与 L1 结果必须一致：worker=${JSON.stringify(wout)} L1=${JSON.stringify(l1out)}`);
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

test('#333 jsoup Elements.remove()：回写 doc，两条路径后续 html()/select() 都看得到删除', async () => {
  const l1ev = createHybridJsEvaluator({ variables: createVariableStore() }) as (
    code: string,
    bindings: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  const l1out = JSON.parse(String(await Promise.resolve(l1ev(REMOVE_CODE_L1, {})))) as { html: string; again: number };
  assert.ok(!String(l1out.html).includes('class="sidebar"'), `L1 remove 后不应残留：${l1out.html}`);
  assert.ok(String(l1out.html).includes('正文甲'), `L1 remove 只删匹配项：${l1out.html}`);
  assert.equal(l1out.again, 0, `L1 再次 select 应为 0：${JSON.stringify(l1out)}`);

  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async () => ({ status: 200, headers: {}, body: CITY_HTML }),
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
  const wout = JSON.parse(String(await Promise.resolve(ev(REMOVE_CODE_WORKER, { baseUrl: 'https://s.test' })))) as {
    html: string;
    again: number;
  };
  assert.ok(!String(wout.html).includes('class="sidebar"'), `worker remove 后不应残留：${wout.html}`);
  assert.ok(String(wout.html).includes('正文甲'), `worker remove 只删匹配项：${wout.html}`);
  assert.equal(wout.again, 0, `worker 再次 select 应为 0：${JSON.stringify(wout)}`);
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

// ---------------------------------------------------------------------------
// `#474` 回归锁：`Packages.org.jsoup.Jsoup.parse`（与裸全局 `org` 同一份桥）
//
// 真因（爱丽丝书屋目录 0 章）：源脚本写 `Packages.org.jsoup.Jsoup.parse(html)` ——
//   L1 的 `Packages`（makeJavaPackages）与 worker 的 `Packages` proxy 都只挂了 java/android，
//   `org` 只挂在**裸全局**上 ⇒ 该写法落 nest() 空桩（留痕「未实现的 Java 类/成员：Packages.org」），
//   `doc.selectFirst is not a function` ⇒ 目录恒空。
// 修法：两处 `Packages` 都补 `org`，且**共用同一个** org 桥实例（不写第二份实现）。
// ---------------------------------------------------------------------------

const PKG_ORG_CODE_L1 = [
  "var doc = Packages.org.jsoup.Jsoup.parse(" + JSON.stringify(CITY_HTML) + ");",
  "var c = doc.selectFirst('.content_left');",
  "JSON.stringify({ hit: c == null ? null : c.html(), bare: typeof org.jsoup.Jsoup.parse('').selectFirst, same: Packages.org === org });",
].join('\n');

/**
 * ⚠️ 这条**只测 L1**：含 `Packages.` 的脚本被 `needsJavaBridgeL1` 强制留 L1
 * （worker 侧 `Packages.org` 只是**对偶补齐**，防将来路由改动后两边不一致）。
 * 所以不能像 `#333` 那样用 `java.ajax` 去逼 worker 路径 —— 那反而会退回 L1，
 * 而 L1 的 `java.ajax` 走 `execFileSync(curl)`，本机沙箱里恒返回空串。
 */
test('#474 Packages.org.jsoup.Jsoup.parse 可用，且与裸全局 org 共用同一份桥', async () => {
  const ev = createHybridJsEvaluator({ variables: createVariableStore() }) as (
    code: string,
    bindings: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  const out = JSON.parse(String(await Promise.resolve(ev(PKG_ORG_CODE_L1, {})))) as {
    hit: string | null;
    bare: string;
    same: boolean;
  };
  assert.ok(out.hit && out.hit.includes('正文甲'), `Packages.org.jsoup 应解析并 selectFirst：${JSON.stringify(out)}`);
  assert.equal(out.bare, 'function', `裸全局 org 的 selectFirst 也必须是函数：${JSON.stringify(out)}`);
  assert.equal(out.same, true, 'Packages.org 必须与裸全局 org 是**同一个实例**（不许第二份实现）');
});

const REMOVE_ONE_L1 = [
  "var doc = org.jsoup.Jsoup.parse(" + JSON.stringify(CITY_HTML) + ");",
  "doc.selectFirst('.ad').remove();",
  "JSON.stringify({ html: doc.html(), left: doc.select('.ad').size() });",
].join('\n');

const REMOVE_ONE_WORKER = [
  "var html = java.ajax('https://s.test/x');",
  "var doc = org.jsoup.Jsoup.parse(html);",
  "doc.selectFirst('.ad').remove();",
  "JSON.stringify({ html: doc.html(), left: doc.select('.ad').size() });",
].join('\n');

test('#333 jsoup Element.remove()：只删**这一个**（不是整类），两条路径一致', async () => {
  const l1ev = createHybridJsEvaluator({ variables: createVariableStore() }) as (
    code: string,
    bindings: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  const l1out = JSON.parse(String(await Promise.resolve(l1ev(REMOVE_ONE_L1, {})))) as { html: string; left: number };
  assert.equal(l1out.left, 1, `L1 Element.remove 只应删一个（剩 1）：${JSON.stringify(l1out)}`);
  assert.ok(!String(l1out.html).includes('广告位甲'), `L1 应删掉第一个：${l1out.html}`);
  assert.ok(String(l1out.html).includes('广告位乙'), `L1 不应误删第二个：${l1out.html}`);

  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async () => ({ status: 200, headers: {}, body: CITY_HTML }),
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
  const wout = JSON.parse(String(await Promise.resolve(ev(REMOVE_ONE_WORKER, { baseUrl: 'https://s.test' })))) as {
    html: string;
    left: number;
  };
  assert.deepEqual(wout, l1out, `worker 与 L1 结果必须一致：worker=${JSON.stringify(wout)} L1=${JSON.stringify(l1out)}`);
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

/**
 * `#333` **真实源形态**回归（次元小镇 ruleContent 的完整动作链，见源 `data/imported-sources.json`）：
 * selectFirst → 子元素批量 remove → 按属性条件逐个 remove → getAllElements + ownText 过滤 →
 * attr(k,v) 设值 → **改完读 content.html()**。
 * 旧「字符串快照」模型在这条链上每一步都错；现在必须整条通、且两条路径一致。
 */
const SHAPE_HTML =
  '<html><body><div class="sidebar">侧栏广告</div>' +
  '<div class="content_left">' +
  '<style>.x{color:red}</style><div class="ad">广告位</div>' +
  '<p style="color:#707070">灰色付费提示</p><p>正文甲</p>' +
  '<div>资源下载</div><p>正文乙</p><img src="/a.jpg">' +
  '</div></body></html>';

/** htmlExpr 传 'HTML'（L1 内联）或 "java.ajax('...')"（worker） */
function shapeCode(htmlExpr: string): string {
  return [
    'var doc = org.jsoup.Jsoup.parse(' + htmlExpr + ');',
    "var content = doc.selectFirst('.content_left');",
    'if (content) {',
    "  content.select('style,script,.ad').remove();",
    "  var ps = content.select('p');",
    "  for (var i = 0; i < ps.size(); i++) { if (String(ps.get(i).attr('style')).indexOf('color:#707070') > -1) ps.get(i).remove(); }",
    '  var all = content.getAllElements();',
    "  for (var j = all.size() - 1; j >= 0; j--) { var el = all.get(j); if (String(el.ownText()).indexOf('资源下载') > -1) { el.remove(); } }",
    "  content.select('img').attr('class', 'zoom-img');",
    '}',
    "JSON.stringify({ ok: !!content, html: content ? String(content.html()) : '', zoom: content ? String(content.select('img').attr('class')) : '' });",
  ].join('\n');
}

const SHAPE_L1 = shapeCode(JSON.stringify(SHAPE_HTML));
const SHAPE_WORKER = shapeCode("java.ajax('https://s.test/x')");

type ShapeOut = { ok: boolean; html: string; zoom: string };

function assertShape(v: ShapeOut, tag: string): void {
  assert.equal(v.ok, true, `${tag} selectFirst 应命中 .content_left`);
  // ① 删掉的（在 content 内）确实没了
  assert.ok(!v.html.includes('广告位'), `${tag} .ad 应被删：${v.html}`);
  assert.ok(!v.html.includes('color:red'), `${tag} style 应被删：${v.html}`);
  assert.ok(!v.html.includes('灰色付费提示'), `${tag} 灰提示 p 应被删：${v.html}`);
  assert.ok(!v.html.includes('资源下载'), `${tag} ownText 命中项应被删：${v.html}`);
  // ② 没删的必须还在（防「按索引/选择器误删整类」）
  assert.ok(v.html.includes('正文甲') && v.html.includes('正文乙'), `${tag} 正文不应被误删：${v.html}`);
  // ③ attr(k,v) 设值生效且**改后可读**
  assert.equal(v.zoom, 'zoom-img', `${tag} img class 应被改写：${v.zoom}`);
  assert.ok(v.html.includes('zoom-img'), `${tag} content.html() 应含改写后的 class：${v.html}`);
}

test('#333 真实源形态：selectFirst/remove/ownText/attr 设值/content.html() 全链通（两条路径一致）', async () => {
  const l1ev = createHybridJsEvaluator({ variables: createVariableStore() }) as (
    code: string,
    bindings: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  const l1out = JSON.parse(String(await Promise.resolve(l1ev(SHAPE_L1, {})))) as ShapeOut;
  assertShape(l1out, 'L1');

  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async () => ({ status: 200, headers: {}, body: SHAPE_HTML }),
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
  const wout = JSON.parse(String(await Promise.resolve(ev(SHAPE_WORKER, { baseUrl: 'https://s.test' })))) as ShapeOut;
  assertShape(wout, 'worker');
  assert.equal(wout.html, l1out.html, `worker 与 L1 的 content.html() 必须逐字一致`);
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

test('宿主 DOM 绑定上的 DOM 调用仍留在 L1（不可克隆，语义不能丢）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const calls: string[] = [];
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async () => ({ status: 200, headers: {}, body: '' }),
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;

  // `$` 是「String 包装 + 挂载 jsoup 方法」——脚本在它上调 select()，必须走 L1（worker 拿不到该对象）
  const hostStr = new String('<a href="/a">A</a>') as string & Record<string, unknown>;
  hostStr['select'] = (sel: unknown) => { calls.push(String(sel)); return []; };

  resetBlocks();
  await Promise.resolve(ev("$.select('a'); 'done';", { $: hostStr }));
  assert.deepEqual(calls, ['a'], '宿主 DOM 绑定上的 select 应在 L1 被真正调用');
  // L1 会记录 l1-eval（但不含 HTTP，因为这里没发请求）
  const l1 = blockSamples().filter((s) => s.kind === 'l1-eval');
  assert.equal(l1.length, 1, `应走 L1 一次：${JSON.stringify(l1)}`);

  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});
