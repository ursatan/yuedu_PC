/**
 * 目录/正文章节元数据测试（对齐 Legado 源码语义）：
 *  ① chapterList 前导 `-`（BookChapterList.kt:53-60,124-126）→ 目录反转
 *  ② 章节 url 缺失兜底：卷 → title+index；普通章节 → 当前页 URL（BookChapterList.kt:262-276）
 *  ③ isVolume / isVip / isPay / updateTime 元数据（BookChapterList.kt:232-287，isTrue 语义）
 *  ④ formatJs 章节名格式化（BookChapterList.kt:139-157，bindings index/gInt/title/chapter）
 *  ⑤ 卷章节 content 直接返回空内容、不发请求
 *  ⑥ ContentRule.title 正文取标题 + imgRegex 拆分（BookContent.kt:176-198）
 *  ⑦ ContentRule.subContent 副文（文本追加 / http 二次抓取）（BookContent.kt:128-165）
 * mock http，不依赖真实站点。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://toc.test';

/** 记录请求次数的 mock http（用于验证「卷章节不发请求」） */
function makeCtx(pages: Record<string, string>, counter?: { n: number }): EngineContext {
  return {
    reqId: 'toc-test',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        if (counter) counter.n++;
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
    bookSourceName: '目录测试源',
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

const ch = (n: number) => `<li><a href="/c/${n}.html">第${n}章</a></li>`;
const page = (nums: number[]) => `<html><body><ul id="list">${nums.map(ch).join('')}</ul></body></html>`;

test('元数据①: chapterList 前导 `-` → 目录反转（源站新章在前）', async () => {
  const rule = makeSrc({
    ruleToc: { chapterList: '-#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
  });
  const ctx = makeCtx({ '*': '<html><body><h1>书</h1></body></html>', [`${BASE}/book/1/`]: page([1, 2, 3]) });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.deepEqual(d.chapters?.map((c) => c.title), ['第3章', '第2章', '第1章'], '`-` 前缀反转成正序');
  // order 重新编号（对齐 Legado foreachIndexed）
  assert.deepEqual(d.chapters?.map((c) => c.order), [1, 2, 3]);
});

test('元数据②: `+` 前缀 → 剥掉前缀、保持解析顺序', async () => {
  const rule = makeSrc({
    ruleToc: { chapterList: '+#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
  });
  const ctx = makeCtx({ '*': '<html><body><h1>书</h1></body></html>', [`${BASE}/book/1/`]: page([1, 2, 3]) });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.deepEqual(d.chapters?.map((c) => c.title), ['第1章', '第2章', '第3章']);
});

test('元数据③: 卷/VIP/备注 + url 兜底（卷用 title+index）', async () => {
  // isVolume:"isv" / isVip:"vip" / isPay:"pay" —— Legado 单 token 规则 = 取该属性
  const rule = makeSrc({
    ruleToc: {
      chapterList: '#list li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
      isVolume: 'isv',
      isVip: 'vip',
      isPay: 'pay',
      updateTime: 'span.t@text',
    },
  });
  const html =
    '<html><body><ul id="list">' +
    '<li isv="1"><a>第一卷 风起</a><span class="t">2020-01-01</span></li>' +
    '<li><a href="/c/1.html">第1章</a><span class="t">2万字</span></li>' +
    '<li vip="1" pay="1"><a href="/c/2.html">第2章</a></li>' +
    '</ul></body></html>';
  const ctx = makeCtx({ '*': '<html><body><h1>书</h1></body></html>', [`${BASE}/book/1/`]: html });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  const chs = d.chapters ?? [];
  assert.equal(chs.length, 3);
  // 卷：isVolume + 无真实 url → title+index 占位
  assert.equal(chs[0]?.isVolume, true, '卷标记');
  assert.equal((chs[0]?.payload as { chapterUrl: string }).chapterUrl, '第一卷 风起0', '卷 url = title+index');
  assert.equal(chs[0]?.tag, '2020-01-01', '卷备注');
  // 普通章：相对 url 绝对化 + 备注 + 非 VIP/非付费
  assert.equal((chs[1]?.payload as { chapterUrl: string }).chapterUrl, `${BASE}/c/1.html`);
  assert.equal(chs[1]?.tag, '2万字');
  assert.equal(chs[1]?.isVip, undefined);
  assert.equal(chs[1]?.isPay, undefined);
  assert.equal(chs[1]?.isVolume, undefined);
  // VIP + 付费章
  assert.equal(chs[2]?.isVip, true, 'VIP 标记');
  assert.equal(chs[2]?.isPay, true, '付费标记');
});

test('元数据④: formatJs 用 index/title 重写章节名', async () => {
  const rule = makeSrc({
    ruleToc: {
      chapterList: '#list li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
      formatJs: "'[' + index + '] ' + title",
    },
  });
  const ctx = makeCtx({ '*': '<html><body><h1>书</h1></body></html>', [`${BASE}/book/1/`]: page([1, 2]) });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.deepEqual(d.chapters?.map((c) => c.title), ['[1] 第1章', '[2] 第2章']);
});

test('元数据⑤: 卷章节 content 直接返回空内容、不发请求', async () => {
  const rule = makeSrc();
  const counter = { n: 0 };
  const ctx = makeCtx({ '*': '<html><body></body></html>' }, counter);
  const c = await new LegadoEngine().content(
    rule as never,
    { action: 'content', id: JSON.stringify({ chapterUrl: '第一卷0', isVolume: true }) },
    ctx,
  );
  assert.deepEqual(c.paragraphs, []);
  assert.equal(counter.n, 0, '卷章节不应发请求');
});

test('元数据⑥: ContentRule.title 从正文取标题（含 imgRegex 拆分）', async () => {
  const rule = makeSrc({
    ruleBookInfo: { name: 'h1@text', tocUrl: '/book/1/' },
    ruleContent: { content: '.con@html', title: 'h1@title' },
  });
  const ctx = makeCtx({
    '*': '<html><body><h1>书</h1><ul id="list"></ul></body></html>',
    [`${BASE}/book/1/`]: page([1, 2]),
    // 标题值以图片 URL 结尾 → imgRegex 前半为标题（Legado AppPattern.imgRegex）
    [`${BASE}/c/1.html`]: '<html><body><h1 title="第1章 风起https://img.test/p.jpg">x</h1><div class="con">正文一</div></body></html>',
    // 普通标题（无 URL）→ 原样作为章节名
    [`${BASE}/c/2.html`]: '<html><body><h1 title="第2章 云涌">x</h1><div class="con">正文二</div></body></html>',
  });
  const engine = new LegadoEngine();
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  const c1 = await engine.content(rule as never, { action: 'content', id: JSON.stringify(d.chapters![0]!.payload) }, ctx);
  assert.equal(c1.title, '第1章 风起', 'imgRegex 前半作为标题');
  assert.deepEqual(c1.paragraphs, ['正文一']);
  const c2 = await engine.content(rule as never, { action: 'content', id: JSON.stringify(d.chapters![1]!.payload) }, ctx);
  assert.equal(c2.title, '第2章 云涌', '普通标题原样使用');
});

test('元数据⑦: ContentRule.subContent 文本类追加正文', async () => {
  const rule = makeSrc({
    ruleContent: { content: '.con@html', subContent: '.sub@text' },
  });
  const html =
    '<html><body><div class="con"><p>正文内容</p></div><div class="sub">附：作者的话</div></body></html>';
  const ctx = makeCtx({
    '*': '<html><body><h1>书</h1><ul id="list"></ul></body></html>',
    [`${BASE}/book/1/`]: page([1]),
    [`${BASE}/c/1.html`]: html,
  });
  const engine = new LegadoEngine();
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(d.chapters![0]!.payload) }, ctx);
  assert.equal(c.subContent, '附：作者的话');
  assert.deepEqual(c.paragraphs, ['正文内容', '附：作者的话'], '文本类副文拼在正文后');
});

test('元数据⑧: ContentRule.subContent 值为 http → 二次抓取（歌词/弹幕）', async () => {
  const rule = makeSrc({
    bookSourceType: 1, // 音频源：副文即歌词
    ruleContent: { content: '.con@html', subContent: `<js>'${BASE}/lyric.txt'</js>` },
  });
  const audio = 'https://cdn.test/a1.mp3,{"headers":{"Referer":"https://toc.test/"}}';
  const ctx = makeCtx({
    '*': '<html><body><h1>书</h1><ul id="list"></ul></body></html>',
    [`${BASE}/book/1/`]: page([1]),
    [`${BASE}/c/1.html`]: `<html><body><div class="con"><audio src="${audio}"></audio></div></body></html>`,
    [`${BASE}/lyric.txt`]: '[00:01]第一句\n[00:05]第二句',
  });
  const engine = new LegadoEngine();
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(d.chapters![0]!.payload) }, ctx);
  assert.equal(c.media?.url, 'https://cdn.test/a1.mp3', '媒体直链');
  assert.ok(c.subContent?.includes('第一句'), '副文来自二次抓取');
  assert.deepEqual(c.paragraphs, [], '音频源不把歌词塞进正文段落');
});

test('元数据⑨: LinkedHashSet 去重——「最新章节预览块 + 完整目录」重复场景（Legado BookChapterList.kt:129-133）', async () => {
  // 无 `-`：解析序 [3,1,2,3,4]（预览块先出现第3章）→ reverse → [4,3,2,1,3']
  // → 去重保留后出现的（完整目录里的 3'；预览块那份 3 丢弃）→ [4,3,2,1] → reverse → [1,2,3,4]
  const rule = makeSrc();
  const html =
    '<html><body><ul id="list">' +
    '<li><a href="/c/3.html">第3章</a></li>' + // 预览块
    '<li><a href="/c/1.html">第1章</a></li>' +
    '<li><a href="/c/2.html">第2章</a></li>' +
    '<li><a href="/c/3.html">第3章</a></li>' + // 完整目录
    '<li><a href="/c/4.html">第4章</a></li>' +
    '</ul></body></html>';
  const ctx = makeCtx({ '*': '<html><body><h1>书</h1></body></html>', [`${BASE}/book/1/`]: html });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.deepEqual(d.chapters?.map((c) => c.title), ['第1章', '第2章', '第3章', '第4章'], '去重后 4 章且顺序为解析序');
  assert.deepEqual(d.chapters?.map((c) => c.order), [1, 2, 3, 4], '去重后重新编号');
});

test('元数据⑩: 带 `-` 前缀 + 重复章节 → 去重保先出现的（解析序），再反转', async () => {
  // `-`：解析序 [2,1,2'] → 不做 step1 reverse → 去重保先出现 [2,1] → reverse → [1,2]
  const rule = makeSrc({
    ruleToc: { chapterList: '-#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
  });
  const html =
    '<html><body><ul id="list">' +
    '<li><a href="/c/2.html">第2章</a></li>' + // 预览块（新章在前）
    '<li><a href="/c/1.html">第1章</a></li>' +
    '<li><a href="/c/2.html">第2章</a></li>' + // 完整目录
    '</ul></body></html>';
  const ctx = makeCtx({ '*': '<html><body><h1>书</h1></body></html>', [`${BASE}/book/1/`]: html });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.deepEqual(d.chapters?.map((c) => c.title), ['第1章', '第2章'], '去重后反转成正序');
});

test('元数据⑪: 同标题不同 URL 不去重；同 URL 不同标题不去重（判等 = title+url+isVolume）', async () => {
  const rule = makeSrc();
  const html =
    '<html><body><ul id="list">' +
    '<li><a href="/c/1.html">第1章</a></li>' +
    '<li><a href="/c/1v2.html">第1章</a></li>' + // 同名不同址：保留
    '<li><a href="/c/2.html">第2章(修)</a></li>' +
    '<li><a href="/c/2.html">第2章</a></li>' + // 同址不同名：保留
    '</ul></body></html>';
  const ctx = makeCtx({ '*': '<html><body><h1>书</h1></body></html>', [`${BASE}/book/1/`]: html });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.equal(d.chapters?.length, 4, 'title+url 组合判等，均不重复');
});
