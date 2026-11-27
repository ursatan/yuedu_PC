/**
 * 回归锁：2026-09-23 用户实测的三类缺陷（engine 侧）
 *
 * · **类AJ** —— `,{options}` 尾巴必须在**插值之后**切
 *   （Legado `AnalyzeUrl.initUrl`: analyzeJs → replaceKeyPageJs → analyzeUrl）。
 *   实测 ⚡📂️独阅读网：explore 选项值 = `{{ URL("/bookcity/get_rank_book_list", {…}) }}`，
 *   `URL(` 的第二个实参被当成尾巴切走 ⇒ 模板没有闭合 `}}` ⇒ 正则零匹配、原样请求 ⇒
 *   站点回错误信封 ⇒ `RULE_PARSE@parse`。
 *
 * · **类AL** —— 目录阶段的 `book.name` 必须是**已解析出的书名**
 *   （Legado `BookChapterList.kt:200` 的 `AnalyzeRule(book, …)` 拿到的是 BookInfo 填好的实体）。
 *   实测 🎨51漫画单章目录：回退分支 `[{ title: book.name, url: … }]` 里 `book.name` 为 undefined
 *   ⇒ `JSON.stringify` 连 title 键都没有 ⇒ `chapterName` 为空被滤掉 ⇒ 0 章。
 *
 * · **类AN** —— `source.get/put` 是**独立且持久**的命名空间
 *   （Legado `BaseSource.kt:345-356`：`CacheManager` 键 `v_<源key>_<键>`，与
 *   `getVariable/setVariable` 的 `sourceVariable_<key>` **不是一回事**）。
 *   实测 🏷七猫四合一：设备指纹/token 靠 `source.put` 缓存，不落盘 ⇒ 每次重生成 ⇒
 *   站点判「token 与设备不符」⇒ 401 `{"Status":"Unauthorized"}`。
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
    bookSourceName: '回归源',
    bookSourceType: 0,
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'bookName' },
    ...over,
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

function makeCtx(body = '{"bookName":"书名","author":"作者"}') {
  const reqs: Array<{ url: string; method: string; body?: string }> = [];
  const ctx: EngineContext = {
    reqId: 'tail',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string, opts?: HttpRequestOptions): Promise<HttpResponse> {
        const b = typeof opts?.body === 'string' ? opts.body : undefined;
        reqs.push({ url, method: opts?.method ?? 'GET', ...(b !== undefined ? { body: b } : {}) });
        return { status: 200, headers: { 'content-type': 'text/html' }, body, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, reqs };
}

/* ---------------- 类AJ ---------------- */

test('类AJ：`{{ }}` 模板里的 `,{` 不得被当成 URL 尾巴切走（独阅读网形态）', async () => {
  /**
   * 原始模板文本里**字面含有 `, {`**（第二个实参）—— 这正是旧实现被切坏的地方：
   * 切完只剩 `{{ (function(p, o){ return 'https://d.test' + p`（没有闭合 `}}`）
   * ⇒ interpUrl 零匹配、原样返回 ⇒ 请求发成一段 JS 源码。
   */
  const tpl = `{{ (function(p, o){ return '${BASE}' + p + ',' + JSON.stringify(o) })('/api/rank', {method:'POST', body:'secret'}) }}`;
  const rule = makeSrc({ searchUrl: tpl });
  const { ctx, reqs } = makeCtx();
  await new LegadoEngine().search(rule, { action: 'search', keyword: 'x' }, ctx);
  const r = reqs[0];
  assert.ok(r, '必须发出搜索请求');
  assert.equal(r.url, `${BASE}/api/rank`, `URL 主体必须来自插值结果：${r.url}`);
  assert.equal(r.method, 'POST', `插值结果里的 ,{options} 仍要解析出 POST：${JSON.stringify(r)}`);
  assert.equal(r.body, 'secret', `body 必须解析出来：${r.body}`);
});

test('类AJ：普通 URL 尾巴（非模板）行为不变', async () => {
  const rule = makeSrc({ searchUrl: `${BASE}/api/s?q={{key}},{"method":"POST",body:"zz"}` });
  const { ctx, reqs } = makeCtx();
  await new LegadoEngine().search(rule, { action: 'search', keyword: 'k' }, ctx);
  assert.equal(reqs[0]?.url, `${BASE}/api/s?q=k`);
  assert.equal(reqs[0]?.method, 'POST');
  assert.equal(reqs[0]?.body, 'zz');
});

test('类AJ：百分号编码的尾巴仍能解析（点众阅读形态，不得回退）', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx();
  const tail = `%7B%22method%22:%20%22post%22,%20body:%20%22abc%22%7D`;
  await new LegadoEngine().detail(rule, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/1,${tail}` }) }, ctx);
  assert.equal(reqs[0]?.url, `${BASE}/api/1`);
  assert.equal(reqs[0]?.method, 'POST');
  assert.equal(reqs[0]?.body, 'abc');
});

/* ---------------- 类AL ---------------- */

test('类AL：目录规则里的 book.name 必须是已解析出的书名（51漫画单章回退分支）', async () => {
  const rule = makeSrc({
    // 详情页给书名
    ruleBookInfo: { name: 'h1@text' },
    // 目录回退分支：源里就是 `[{ title: book.name, url: java.getString('.btn-read@href', src) }]`
    ruleToc: {
      chapterList: `<js>[{ title: book.name, url: '/comic/1/chapter/2' }]</js>\n$[*]`,
      chapterName: '$.title',
      chapterUrl: '$.url',
    },
  });
  const { ctx } = makeCtx('<html><body><h1>换身小确幸</h1></body></html>');
  const d = (await new LegadoEngine().detail(rule, { action: 'detail', id: JSON.stringify({ bookUrl: BASE }) }, ctx)) as unknown as {
    chapters?: Array<{ title: string; payload?: { chapterUrl?: string } }>;
  };
  assert.equal(d.chapters?.length, 1, `目录必须出 1 章（旧实现 title 为空被滤掉 → 0 章）：${JSON.stringify(d.chapters)}`);
  assert.equal(d.chapters?.[0]?.title, '换身小确幸');
  assert.equal(d.chapters?.[0]?.payload?.chapterUrl, `${BASE}/comic/1/chapter/2`);
});

/* ---------------- 类AM ---------------- */

test('类AM：懒加载图片必须优先 data-src（正文只有占位图 → 真实图列表）', async () => {
  const rule = makeSrc({
    bookSourceType: 2,
    ruleContent: { content: '.comics@img@html' },
  });
  const html =
    `<html><body><div class="comics">` +
    `<img src="/static/web/images/loading.png" data-src="${BASE}/img/1.jpg">` +
    `<img src="/static/web/images/loading.png" data-src="${BASE}/img/2.jpg">` +
    `<img src="/static/web/images/loading.png" data-src="${BASE}/img/3.jpg">` +
    `</div></body></html>`;
  const { ctx } = makeCtx(html);
  const c = (await new LegadoEngine().content(rule, { action: 'content', id: JSON.stringify({ chapterUrl: BASE }) }, ctx)) as unknown as {
    paragraphs?: string[];
  };
  const ps = c.paragraphs ?? [];
  assert.equal(ps.length, 3, `静默去重后会只剩 1 张占位图（旧实现）：${JSON.stringify(ps)}`);
  assert.deepEqual(ps, [`${BASE}/img/1.jpg`, `${BASE}/img/2.jpg`, `${BASE}/img/3.jpg`]);
  assert.ok(!ps.some((p) => p.includes('loading.png')), `不得回落到占位图：${JSON.stringify(ps)}`);
});

test('类AM：没有 data-src 时仍取 src（原有能力不回退）', async () => {
  const rule = makeSrc({ bookSourceType: 2, ruleContent: { content: '.comics@img@html' } });
  const html = `<html><body><div class="comics"><img src="${BASE}/a.jpg"><img src="${BASE}/b.jpg"></div></body></html>`;
  const { ctx } = makeCtx(html);
  const c = (await new LegadoEngine().content(rule, { action: 'content', id: JSON.stringify({ chapterUrl: BASE }) }, ctx)) as unknown as {
    paragraphs?: string[];
  };
  assert.deepEqual(c.paragraphs, [`${BASE}/a.jpg`, `${BASE}/b.jpg`]);
});

/* ---------------- 类AN ---------------- */

test('类AN：source.put/get 是独立命名空间，且跨请求落盘（七猫四合一设备/token 形态）', async () => {
  const writer = makeSrc({
    ruleBookInfo: { name: `@js: source.put('qm_device', JSON.stringify({uuid:'u-1'})); '书名'`, author: `@js: source.get('qm_device')` },
  });
  const { ctx } = makeCtx();
  const d1 = (await new LegadoEngine().detail(writer, { action: 'detail', id: JSON.stringify({ bookUrl: BASE }) }, ctx)) as unknown as {
    subtitle?: string;
  };
  // `ruleBookInfo.author` 在 UnifiedDetail 里叫 subtitle（见 engine 的 result 装配）
  assert.equal(d1.subtitle, '{"uuid":"u-1"}', '同请求内 source.get 必须读回刚 put 的值');

  // 跨请求：新源对象、**同一个 storage**（同一 sourceId）→ 必须还能读到
  const reader = makeSrc({ ruleBookInfo: { name: 'bookName', author: `@js: source.get('qm_device')` } });
  const d2 = (await new LegadoEngine().detail(reader, { action: 'detail', id: JSON.stringify({ bookUrl: BASE }) }, ctx)) as unknown as {
    subtitle?: string;
  };
  assert.equal(d2.subtitle, '{"uuid":"u-1"}', 'source.put 必须落盘、跨请求可读（旧实现只写本次请求 variables ⇒ 恒为空）');
});

test('类AN：source.get/put 与 getVariable/setVariable 互不覆盖（两个独立命名空间）', async () => {
  const rule = makeSrc({
    ruleBookInfo: {
      name: `@js: source.put('k', 'A'); source.setVariable(JSON.stringify({k:'B'})); '书名'`,
      author: `@js: source.get('k') + '|' + source.getVariable()`,
    },
  });
  const { ctx } = makeCtx();
  const d = (await new LegadoEngine().detail(rule, { action: 'detail', id: JSON.stringify({ bookUrl: BASE }) }, ctx)) as unknown as {
    subtitle?: string;
  };
  assert.equal(d.subtitle, 'A|{"k":"B"}', `put 与 setVariable 必须各存各的：${d.subtitle}`);
});
