/**
 * 缺陷**类BS + `#149`** 回归锁：`ruleBookInfo.tocUrl` 是 **URL 形状但含规则占位符**时，必须走规则链求值。
 *
 * ## Legado 语义（权威）
 * `app/src/main/java/io/legado/app/model/webBook/BookInfo.kt:157`：
 * ```kotlin
 * book.tocUrl = analyzeRule.getString(infoRule.tocUrl, isUrl = true)   // ★ 无条件，无「像 URL 就跳过」的判定
 * ```
 * 而 `AnalyzeRule.kt:699-730` 用 `evalPattern` 把规则串里**任意位置**的
 * `@get:{…}` / `{{…}}` 都切成 token 求值 —— 占位符在 URL **中间**是完全合法的写法。
 *
 * ## 我们此前的缺陷（`engine.ts` 的 `tocUrlIsRuleText` 守卫）
 * 守卫用「**是否以 `http`/`/`/`{{` 开头**」判定要不要走规则链，于是
 * `https://…?bid=@get:{bid}&order=0` 被当成「纯 URL」直接下发；
 * 而兜底的 `fetchRuleUrl` → `interpUrl` **只认 `{{}}`**（`engine.ts:899`）
 * ⇒ `@get:{bid}` **原样发给站点** ⇒ 目录 0 章。
 * 实测：⚡📂️咪咕阅读（`[url-in] == [url-out]`）· ⚡📂17k小说（`…/list/@get:{id}.html`）。语料 2 源。
 * 同族还有 `##`（含 `##` 一律按规则链）与 **`#149` 的 `@js:`/`<js>`**（见下）。
 *
 * ## `#149`（2026-09-29 修）：`@js:` / `<js>` 也纳入
 * 原先排除它的理由是「走规则链会返回**空串**」——**那个实测是拿 `<js>""</js>` 人造样例做的**
 * （JS 返回空串 ⇒ 空 URL，属**正确**行为），不能推广到真实形态。
 * 用语料里三条**真实规则**复测（`tmp/probe-149-tocurl-js.mts`）全部解出正确 URL：
 * ⚡📂魔丸小说（`{{}}` + `<js>`，解出 `data:;base64,…`）· 🎨拷贝漫画（URL + `<js>`，解出追加了
 * `/group/default/chapters?…` 的 URL）· ⚡📂若夏（XPath + `@js:`，解出 `/chapter/7788/`）。
 *
 * ## 四件事必须同时锁住
 * 1. `@get:{…}` 在 URL 中间时**被替换**（类BS 本体）；
 * 2. `@js:` / `<js>` 形态走规则链后**不留残片**（`#149`）；
 * 3. **纯 URL 不得被清空** —— 这是守卫存在的理由：把纯 URL 塞进 `getString` 会按 CSS 选择器
 *    去匹配 ⇒ **返回空串**（实测 `https://plain.example.com/list.html` → `''`）；
 * 4. `{{…}}` 起头的模板**仍走 `interpUrl`**（那边 bindings 更全），行为不变。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createMemoryKeyValueStore, createTraceSink, createVariableStore } from '@yuedu/core';

import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';

const BASE = 'https://bs.test';

/** 目录页返回的章节（详情页也带一份，便于「未声明 tocUrl」的形态） */
const TOC_BODY = JSON.stringify({
  data: { moielist: [{ id: 1, title: '第1章' }, { id: 2, title: '第2章' }] },
});
const DETAIL_BODY = JSON.stringify({ data: { detail: { id: '116759', title: '剑来' }, moielist: [] } });
/** `#149` 的 XPath 形态要 HTML 详情页（`//*[@property=…]/@content`） */
const DETAIL_HTML = '<html><body><div property="og:novel:read_url" content="/book/7788/"></div></body></html>';

function makeHarness(detailBody = DETAIL_BODY) {
  const requested: string[] = [];
  const variables = createVariableStore();
  // 模拟「上一阶段 put 过 bid」：咪咕阅读 `ruleSearch.wordCount = '@put:{bid:$.bookId}'`
  variables.set('bid', '354235511');

  const ctx: EngineContext = {
    reqId: 'bs-test',
    sourceId: BASE,
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        requested.push(url);
        const body = url.includes('detail') ? detailBody : url.startsWith(BASE) ? TOC_BODY : '{}';
        return { status: 200, headers: { 'content-type': 'application/json' }, body, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables,
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, requested };
}

function makeRule(tocUrl: string) {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '类BS 测试源',
    bookSourceType: 0,
    ruleBookInfo: { name: '$.data.detail.title', tocUrl },
    ruleToc: {
      chapterList: '$.data.moielist[*]',
      chapterName: '$.title',
      chapterUrl: '@js:"https://x.test/read?id="+$.id',
    },
    ruleContent: { content: '$.data.content' },
  });
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);
  return out.rule!;
}

async function runDetail(tocUrl: string, detailBody = DETAIL_BODY) {
  const { ctx, requested } = makeHarness(detailBody);
  const det = (await new LegadoEngine().detail(
    makeRule(tocUrl),
    { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/detail/1.html`, name: '剑来' }) },
    ctx,
  )) as unknown as { chapters?: unknown[] };
  return { requested, chapters: det.chapters ?? [] };
}

test('类BS：URL 中间的 `@get:{bid}` 必须被替换（咪咕阅读形态）', async () => {
  const { requested, chapters } = await runDetail(`${BASE}/toc?cm=0000&bid=@get:{bid}&order=0`);
  const tocReq = requested.find((u) => u.includes('/toc'));
  assert.ok(tocReq, `应请求目录页，实际请求过：${JSON.stringify(requested)}`);
  assert.ok(
    !tocReq.includes('@get:'),
    `目录 URL 不得残留字面量 @get:（这是类BS 的症状），实际 = ${tocReq}`,
  );
  assert.match(tocReq, /bid=354235511/, `@get:{bid} 应解析成 354235511，实际 = ${tocReq}`);
  assert.equal(chapters.length, 2, '目录应解析出 2 章');
});

test('类BS 反向锁：**纯 URL 不得被清空**（把纯 URL 塞进 getString 会返回空串）', async () => {
  const { requested, chapters } = await runDetail(`${BASE}/toc-plain.html`);
  assert.ok(
    requested.includes(`${BASE}/toc-plain.html`),
    `纯 URL 必须原样请求（守卫存在的理由），实际请求过：${JSON.stringify(requested)}`,
  );
  assert.ok(
    !requested.some((u) => u === '' || u.endsWith('/')),
    `不得出现空 URL，实际：${JSON.stringify(requested)}`,
  );
  assert.equal(chapters.length, 2, '纯 URL 目录页仍应解析出 2 章');
});

test('类BS 回归锁：`{{…}}` 起头的模板行为不变（仍由 interpUrl 展开）', async () => {
  const { requested, chapters } = await runDetail(`${BASE}/toc?id={{$.data.detail.id}}&order=0`);
  const tocReq = requested.find((u) => u.includes('/toc'));
  assert.ok(tocReq, `应请求目录页，实际：${JSON.stringify(requested)}`);
  assert.match(tocReq, /id=116759/, `{{$.data.detail.id}} 应展开成 116759，实际 = ${tocReq}`);
  assert.equal(chapters.length, 2, '目录应解析出 2 章');
});

test('`#149`：URL 形状 + `<js>` 块 ⇒ 走规则链，URL 是**被 JS 改写后**的结果（拷贝漫画形态）', async () => {
  // 真实写法：URL 行 + 换行 + <js> 块；JS 用 result（= 上一段即 URL 文本）拼出新 URL
  const rule = `${BASE}/toc\n<js>\nresult = result.replace(/\\s.*/g, '') + '/group/default/chapters?limit=100'\n</js>`;
  const { requested, chapters } = await runDetail(rule);
  const tocReq = requested.find((u) => u.includes('/group/default/chapters'));
  assert.ok(tocReq, `应请求 JS 改写后的目录 URL，实际请求过：${JSON.stringify(requested)}`);
  assert.ok(!tocReq.includes('<js>'), `URL 不得残留 <js> 片段，实际 = ${tocReq}`);
  assert.match(tocReq, /\/group\/default\/chapters\?limit=100$/, `URL 应是 JS 拼出的结果，实际 = ${tocReq}`);
  assert.equal(chapters.length, 2, '目录应解析出 2 章');
});

test('`#149`：XPath + `@js:` 形态同样走规则链（若夏形态）', async () => {
  const rule = `//*[@property='og:novel:read_url']/@content@js:result.replace('/book/','/chapter/')`;
  const { requested, chapters } = await runDetail(rule, DETAIL_HTML);
  const tocReq = requested.find((u) => u.includes('/chapter/'));
  assert.ok(tocReq, `应请求 @js: 改写后的目录 URL，实际请求过：${JSON.stringify(requested)}`);
  assert.match(tocReq, /\/chapter\/7788\/?$/, `XPath 取到的 /book/7788/ 应被改成 /chapter/7788/，实际 = ${tocReq}`);
  assert.equal(chapters.length, 2, '目录应解析出 2 章');
});
