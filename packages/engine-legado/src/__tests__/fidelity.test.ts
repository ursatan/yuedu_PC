/**
 * 选择器保真度 / 阶段补充修复测试（对齐 Legado 源码语义）：
 *  ① ElementsSingle 的 class./tag./id./默认选择器 **含元素自身**（jsoup Collector 语义）
 *     —— `chapterUrl: "tag.a@href"` 作用在 <a> 行上必须能取到（此前恒为空）
 *  ② 规则前导 `@` 先剥离（Legado RuleAnalyzer.trim）—— `@href` 取元素自身属性而非子节点
 *  ③ 空属性不做绝对化（Legado getStringList(isUrl) 过滤空项）—— 不再把空 bookUrl 变成站点根
 *  ④ 列表项 bookUrl 为空 → 回落当前页 URL（BookList.kt:281-284）
 *  ⑤ preUpdateJs：无 content 上下文执行、失败不阻断、可改写 book.bookUrl（WebBook.kt:281-293）
 *  ⑥ source / title / fromBookInfo 绑定（AnalyzeRule.kt:895-910）
 *  ⑦ ContentRule.imageStyle（ReadBook.kt:491-496：图片类源空白默认 FULL）
 *  ⑧ 旧版扁平格式书源自动迁移（ImportOldData.kt）
 * mock http，不依赖真实站点。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import { isLegacyFlatSource } from '../legacy/migrate';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://fid.test';

function makeCtx(pages: Record<string, string>): EngineContext {
  return {
    reqId: 'fid-test',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        const body = pages[url] ?? pages['*'] ?? '<html><body></body></html>';
        return { status: 200, headers: { 'content-type': 'text/html' }, body, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

function makeSrc(over: Record<string, unknown> = {}) {
  const raw = {
    bookSourceUrl: BASE,
    bookSourceName: '保真测试源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: '/book/1/' },
    ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.con@html' },
    ...over,
  };
  const out = compileBookSource(raw);
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

const SEARCH_HTML =
  '<html><body><ul class="list">' +
  '<li class="item"><a href="/book/1/">书一</a><span class="n">书一</span></li>' +
  '<li class="item"><a>书二（无链接）</a><span class="n">书二</span></li>' +
  '</ul></body></html>';

test('①+②: tag.a@href 落在 <a> 行上可取到（含自身）；@href 取自身而非子节点', async () => {
  const rule = makeSrc({
    // bookList 直接命中 <a> 行：Legado/JSoup 的 tag. 与 class. 都包含元素自身
    ruleSearch: { bookList: 'class.list@tag.a', name: 'text', bookUrl: 'tag.a@href' },
  });
  const out = await new LegadoEngine().search(rule as never, { action: 'search', keyword: '我' }, makeCtx({ '*': SEARCH_HTML }));
  assert.equal(out.items.length, 2, '两条结果');
  assert.equal((out.items[0]?.payload as { bookUrl: string }).bookUrl, `${BASE}/book/1/`, 'tag.a@href 生效');
  assert.equal(out.items[0]?.title, '书一');
});

test('③+④: 空属性不绝对化成站点根；bookUrl 为空时回落当前页 URL', async () => {
  const rule = makeSrc({
    ruleSearch: { bookList: 'class.list@tag.li', name: 'span.n@text', bookUrl: 'tag.a@href' },
  });
  const out = await new LegadoEngine().search(rule as never, { action: 'search', keyword: '我' }, makeCtx({ '*': SEARCH_HTML }));
  const urls = out.items.map((i) => (i.payload as { bookUrl: string }).bookUrl);
  assert.equal(urls[0], `${BASE}/book/1/`);
  // 无 href 的行：不再产出 "https://fid.test"（站点根），而是回落搜索页 URL（Legado BookList.kt:284）
  assert.notEqual(urls[1], BASE, '空属性不得绝对化成站点根');
  assert.ok(String(urls[1]).startsWith(`${BASE}/s?q=`), '回落当前页 URL');
});

test('⑤: preUpdateJs 执行 + 改写 book.bookUrl 生效（换域名源）', async () => {
  const rule = makeSrc({
    ruleToc: {
      chapterList: '#list li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
      // 混合三种形态：java 桥不影响、source 绑定、book.bookUrl 改写
      preUpdateJs: `if (java.refreshTocUrl()==='' && String(source.bookSourceUrl).includes('fid.test')) { book.bookUrl = '${BASE}/book/9/'; }`,
    },
    ruleBookInfo: { name: 'h1@text', tocUrl: '{{baseUrl}}' },
  });
  const ctx = makeCtx({
    [`${BASE}/book/1/`]: '<html><body><h1>旧页</h1></body></html>',
    [`${BASE}/book/9/`]: '<html><body><h1>新页</h1><ul id="list"><li><a href="/c/1.html">第1章</a></li></ul></body></html>',
    '*': '<html><body><h1>书</h1><ul id="list"></ul></body></html>',
  });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.equal(d.chapters?.length, 1, '改写后的 URL 被使用（否则旧页 0 章）');
  assert.equal(d.chapters?.[0]?.title, '第1章');
});

test('⑤b: preUpdateJs 抛错不阻断目录（Legado 只记日志）', async () => {
  const rule = makeSrc({
    ruleToc: {
      chapterList: '#list li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
      preUpdateJs: 'throw new Error("boom")',
    },
    ruleBookInfo: { name: 'h1@text', tocUrl: '{{baseUrl}}' },
  });
  const ctx = makeCtx({
    '*': '<html><body><h1>书</h1><ul id="list"><li><a href="/c/1.html">第1章</a></li></ul></body></html>',
  });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.equal(d.chapters?.length, 1, '目录仍可用');
});

test('⑥: content 规则可用 title / source 绑定（AnalyzeRule.kt:898,903）', async () => {
  const rule = makeSrc({
    ruleContent: {
      content: '.con@html',
      // title 绑定 = 目录里的章节名；source.bookSourceName = 源名
      title: `<js>title + " @ " + source.bookSourceName</js>`,
    },
    ruleBookInfo: { name: 'h1@text', tocUrl: '{{baseUrl}}' },
  });
  const ctx = makeCtx({
    '*': '<html><body><h1>书</h1><ul id="list"><li><a href="/c/1.html">第1章</a></li></ul></body></html>',
    [`${BASE}/c/1.html`]: '<html><body><div class="con">正文</div></body></html>',
  });
  const engine = new LegadoEngine();
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(d.chapters![0]!.payload) }, ctx);
  assert.equal(c.title, '第1章 @ 保真测试源', 'title / source 绑定可用');
});

test('⑦: imageStyle —— 缺省图片类源默认 FULL，声明 single 归一为 SINGLE', async () => {
  const comic = makeSrc({
    bookSourceType: 2,
    ruleBookInfo: { name: 'h1@text', tocUrl: '{{baseUrl}}' },
    ruleContent: { content: 'div.pages@html' },
  });
  const ctx = makeCtx({
    '*': '<html><body><h1>漫画</h1><ul id="list"><li><a href="/c/1.html">第1话</a></li></ul></body></html>',
    [`${BASE}/c/1.html`]: '<html><body><div class="pages"><img src="/i/1.jpg"><img src="/i/2.jpg"></div></body></html>',
  });
  const engine = new LegadoEngine();
  const d = await engine.detail(comic as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  const c1 = await engine.content(comic as never, { action: 'content', id: JSON.stringify(d.chapters![0]!.payload) }, ctx);
  assert.equal(c1.imageStyle, 'FULL', '图片类源缺省 FULL');
  assert.deepEqual(c1.paragraphs, [`${BASE}/i/1.jpg`, `${BASE}/i/2.jpg`]);

  const single = makeSrc({
    bookSourceType: 2,
    ruleBookInfo: { name: 'h1@text', tocUrl: '{{baseUrl}}' },
    ruleContent: { content: 'div.pages@html', imageStyle: 'single' },
  });
  const d2 = await engine.detail(single as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  const c2 = await engine.content(single as never, { action: 'content', id: JSON.stringify(d2.chapters![0]!.payload) }, ctx);
  assert.equal(c2.imageStyle, 'SINGLE', '忽略大小写归一');
});

test('⑧: 旧版扁平格式书源（v1）自动迁移后可用', async () => {
  const legacy = {
    bookSourceUrl: BASE,
    bookSourceName: '旧格式源',
    bookSourceType: '0',
    ruleSearchUrl: '/s?q=searchKey&page=searchPage',
    ruleSearchList: '.item',
    ruleSearchName: 'a@text',
    ruleSearchNoteUrl: 'a@href',
    ruleChapterList: 'tag.li',
    ruleChapterName: 'a@text',
    ruleContentUrl: 'a@href',
    ruleBookContent: '.con@html',
  };
  assert.equal(isLegacyFlatSource(legacy), true, '识别为旧格式');
  const out = compileBookSource(legacy);
  assert.ok(out.ok && out.rule, '旧格式可编译');
  assert.equal(out.rule!.ruleToc?.chapterList, 'tag.li', 'ruleChapterList → ruleToc.chapterList');
  assert.equal(out.rule!.ruleContent?.content, '.con@html');
  assert.ok(String(out.rule!.searchUrl).includes('/s?q='), 'ruleSearchUrl → searchUrl');
  // 新格式源不得被误迁移
  const modern = makeSrc();
  assert.equal(isLegacyFlatSource(modern), false, '新格式不判定为旧格式');
  assert.equal(modern.ruleToc?.chapterList, '#list li');
});
