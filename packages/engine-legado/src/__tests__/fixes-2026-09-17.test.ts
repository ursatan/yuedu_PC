/**
 * 回归锁（2026-09-17，源类实测清单修复）
 *
 * 覆盖本轮修掉的 5 处引擎缺陷（全部由用户真实源实测暴露）：
 *  1. 详情页书名回落链**不得落到 bookUrl**（Legado `BookInfo.kt:68-73`：name 为空不覆盖已有书名）
 *     —— 修复前：无 `ruleBookInfo` 的源（绾书/磨铁/红薯/疯读/武芊…）详情页把 bookUrl 当书名显示。
 *  2. `@put:{...}` 的非标准 JSON（语料 34 处**全是**无引号键）必须能解析
 *     —— 修复前：静默丢弃 → `@get:{k}` 恒为空（全免漫画 `comic_id=` 为空 → 正文取不到图）。
 *  3. `tocUrl` 里的 `{{<规则>}}`（如 `{{$..comic_id}}`）按**规则**求值（Legado makeUpRule 的 isRule 分支）
 *     —— 修复前：一律走 JS 求值，`$..comic_id` 语法错 → 空串（武芊漫画目录只剩 1 条）。
 *  4. image 类源的内容规则返回**媒体直链**时产出 `media`（而不是一张坏图）
 *     —— 实测：红牛资源 `bookSourceType=2` 但正文是 m3u8。
 *  5. `source.getLoginHeaderMap()` 等 BaseSource 方法必须存在
 *     —— 修复前：书耽搜索直接 `RULE_PARSE: source.getLoginHeaderMap is not a function`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://fix.test';

function makeCtx(pages: Record<string, string>): { ctx: EngineContext; seen: string[] } {
  const seen: string[] = [];
  const ctx: EngineContext = {
    reqId: 'fix',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        seen.push(url);
        const body = pages[url] ?? pages['*'] ?? '{}';
        return { status: 200, headers: { 'content-type': 'application/json' }, body, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, seen };
}

function makeSrc(over: Record<string, unknown> = {}) {
  const raw = {
    bookSourceUrl: `${BASE}/`,
    bookSourceName: '回归测试源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text' },
    ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.con@html' },
    ...over,
  };
  const out = compileBookSource(raw);
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

const SEARCH_HTML = `<html><body><div class="item"><a href="${BASE}/book/1">搜索到的书名</a></div></body></html>`;
const BOOK_HTML = `<html><body><h1>详情页书名</h1><div id="list"><li><a href="/c/1">第1章</a></li></ul></div></body></html>`;

async function searchFirst(rule: ReturnType<typeof makeSrc>, pages: Record<string, string>) {
  const eng = new LegadoEngine();
  const s = (await eng.search(rule, { action: 'search', keyword: 'x' }, makeCtx(pages).ctx)) as unknown as {
    items?: Array<Record<string, unknown>>;
  };
  const first = (s.items ?? [])[0];
  assert.ok(first, '搜索应有结果');
  return { eng, first, pages };
}

/** 用同一份 pages 跑 detail（否则详情页响应是 `{}`，规则自然取不到值） */
const PAGES_HTML = { [`${BASE}/s?q=x`]: SEARCH_HTML, [`${BASE}/book/1`]: BOOK_HTML };

test('① 详情书名回落链：ruleBookInfo 缺 name → 用搜索到的书名，绝不落到 bookUrl', async () => {
  const rule = makeSrc({ ruleBookInfo: {} });
  const { eng, first, pages } = await searchFirst(rule, PAGES_HTML);
  // 搜索阶段 payload 必须带上书名（Legado 的 SearchBook.name）
  assert.equal((first.payload as { name?: string }).name, '搜索到的书名', 'payload 应带搜索结果书名');
  const d = (await eng.detail(rule, { action: 'detail', id: JSON.stringify(first.payload) }, makeCtx(pages).ctx)) as {
    title?: string;
  };
  assert.equal(d.title, '搜索到的书名', '没有 ruleBookInfo.name 时必须沿用搜索书名');
  assert.ok(!String(d.title).includes('fix.test'), `书名不得是 bookUrl：${d.title}`);
});

test('①b 详情书名：ruleBookInfo.name 有值时优先于搜索书名', async () => {
  const rule = makeSrc({ ruleBookInfo: { name: 'h1@text' } });
  const { eng, first, pages } = await searchFirst(rule, PAGES_HTML);
  const d = (await eng.detail(rule, { action: 'detail', id: JSON.stringify(first.payload) }, makeCtx(pages).ctx)) as {
    title?: string;
  };
  assert.equal(d.title, '详情页书名');
});

test('② @put 非标准 JSON（无引号键）必须生效，@get 能取到', async () => {
  const rule = makeSrc({
    bookSourceUrl: BASE,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '$.list[*]', name: '$.name', bookUrl: '$.bookUrl' },
    ruleBookInfo: { name: '$.name@put:{cid:$.id}' },
    ruleToc: { chapterList: '$.chapters[*]', chapterName: '$.t', chapterUrl: `${BASE}/read?cid=@get:{cid}&c={{$.c}}` },
  });
  const pages = {
    [`${BASE}/s?q=x`]: JSON.stringify({ list: [{ name: '书', bookUrl: `${BASE}/book/1` }] }),
    [`${BASE}/book/1`]: JSON.stringify({ name: '书', id: '77', chapters: [{ t: '第1章', c: '9' }] }),
  };
  const { eng, first } = await searchFirst(rule, pages);
  const { ctx } = makeCtx(pages);
  const d = (await eng.detail(rule, { action: 'detail', id: JSON.stringify(first.payload) }, ctx)) as {
    title?: string; chapters?: Array<{ payload?: { chapterUrl?: string } }>;
  };
  assert.equal(d.title, '书', '@put 不应影响 name 本身');
  const ch = (d.chapters ?? [])[0];
  assert.ok(ch, '应有章节');
  const u = String(ch.payload?.chapterUrl ?? '');
  assert.ok(u.includes('cid=77'), `@get:{cid} 应取到 77：${u}`);
  assert.ok(u.includes('c=9'), `{{$.c}} 应取到 9：${u}`);
});

test('③ tocUrl 里的 {{<规则>}} 按规则求值（isRule 分支）', async () => {
  const bookBody = JSON.stringify({ name: '书', id: '55', chapters: [] });
  const tocBody = JSON.stringify({ chapters: [{ t: '第1章', c: '1' }] });
  const rule = makeSrc({
    bookSourceUrl: BASE,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '$.list[*]', name: '$.name', bookUrl: '$.bookUrl' },
    // `{{$..id}}` 是递归下降 JSONPath —— 必须走规则求值（JS 求值会语法错 → 空串）
    ruleBookInfo: { name: '$.name', tocUrl: `${BASE}/toc?bid={{$..id}}` },
    ruleToc: { chapterList: '$.chapters[*]', chapterName: '$.t', chapterUrl: `${BASE}/read?c={{$.c}}` },
  });
  const pages: Record<string, string> = {
    [`${BASE}/s?q=x`]: JSON.stringify({ list: [{ name: '书', bookUrl: `${BASE}/book/1` }] }),
    [`${BASE}/book/1`]: bookBody,
    [`${BASE}/toc?bid=55`]: tocBody,
  };
  const { eng, first } = await searchFirst(rule, pages);
  const { ctx, seen } = makeCtx(pages);
  const d = (await eng.detail(rule, { action: 'detail', id: JSON.stringify(first.payload) }, ctx)) as {
    chapters?: unknown[];
  };
  assert.ok(seen.some((u) => u.includes('bid=55')), `tocUrl 应解析出 bid=55，实际请求：${JSON.stringify(seen)}`);
  assert.equal((d.chapters ?? []).length, 1, '应从目录页解析出 1 章');
});

test('④ image 类源的内容规则返回媒体直链 → 产出 media（不是坏图）', async () => {
  const rule = makeSrc({
    bookSourceUrl: BASE,
    bookSourceType: 2, // 图片（漫画）——但正文规则实际给的是 m3u8（红牛资源那种）
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '$.list[*]', name: '$.name', bookUrl: '$.bookUrl' },
    ruleBookInfo: { name: '$.name' },
    ruleToc: { chapterList: '$.chapters[*]', chapterName: '$.t', chapterUrl: '$.u' },
    ruleContent: { content: '$.url' },
  });
  const pages = {
    [`${BASE}/s?q=x`]: JSON.stringify({ list: [{ name: '剧', bookUrl: `${BASE}/book/1` }] }),
    [`${BASE}/book/1`]: JSON.stringify({ name: '剧', chapters: [{ t: '第1集', u: `${BASE}/read/1` }] }),
    [`${BASE}/read/1`]: JSON.stringify({ url: 'https://cdn.test/a/index.m3u8' }),
  };
  const { eng, first } = await searchFirst(rule, pages);
  const { ctx } = makeCtx(pages);
  const d = (await eng.detail(rule, { action: 'detail', id: JSON.stringify(first.payload) }, ctx)) as {
    chapters?: Array<{ payload?: unknown }>;
  };
  const c = (await eng.content(rule, { action: 'content', id: JSON.stringify(d.chapters![0]!.payload) }, ctx)) as {
    paragraphs?: string[]; media?: { url?: string; format?: string };
  };
  assert.equal(c.media?.url, 'https://cdn.test/a/index.m3u8', '应产出 media.url');
  assert.equal(c.media?.format, 'm3u8', '应推断出 m3u8 格式');
  assert.equal((c.paragraphs ?? []).length, 0, '不应把直链当段落/坏图');
});

test('⑤ source.getLoginHeaderMap() 等方法必须存在（书耽那种直调）', async () => {
  const rule = makeSrc({
    bookSourceUrl: BASE,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '$.list[*]', name: '$.name', bookUrl: '$.bookUrl' },
    ruleBookInfo: { name: '$.name' },
    ruleToc: { chapterList: '$.chapters[*]', chapterName: '$.t', chapterUrl: '$.u' },
    ruleContent: {
      content:
        "<js>var m=source.getLoginHeaderMap();var v=source.putVariable('x');var c=source.getComment();" +
        "'头='+(m==null?'none':'map')+'|变量='+(typeof v)+'|备注='+(typeof c)</js>",
    },
  });
  const pages = {
    [`${BASE}/s?q=x`]: JSON.stringify({ list: [{ name: '书', bookUrl: `${BASE}/book/1` }] }),
    [`${BASE}/book/1`]: JSON.stringify({ name: '书', chapters: [{ t: '第1章', u: `${BASE}/read/1` }] }),
    [`${BASE}/read/1`]: JSON.stringify({ any: 1 }),
  };
  const { eng, first } = await searchFirst(rule, pages);
  const { ctx } = makeCtx(pages);
  const d = (await eng.detail(rule, { action: 'detail', id: JSON.stringify(first.payload) }, ctx)) as {
    chapters?: Array<{ payload?: unknown }>;
  };
  const c = (await eng.content(rule, { action: 'content', id: JSON.stringify(d.chapters![0]!.payload) }, ctx)) as {
    paragraphs?: string[];
  };
  const text = (c.paragraphs ?? []).join('\n');
  assert.ok(text.includes('头=none'), `getLoginHeaderMap 应可调用：${text}`);
  assert.ok(!text.includes('is not a function'), `不应有 is not a function：${text}`);
});
