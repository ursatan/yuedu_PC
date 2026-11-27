/**
 * 缺陷类BK 回归锁：**`ruleContent.content` 为空 → 正文就是章节链接**。
 *
 * 依据（Legado `WebBook.kt:429-432`）：
 * ```kotlin
 * val contentRule = bookSource.getContentRule()
 * if (contentRule.content.isNullOrEmpty()) {
 *     Debug.log(bookSource.bookSourceUrl, "⇒正文规则为空,使用章节链接:${bookChapter.url}")
 *     return bookChapter.url
 * }
 * ```
 * 两个要点必须锁住：
 *   ① 产物是**章节链接本身**（媒体类源 → `media.url`；文本/图片类源 → 一段该地址）；
 *   ② **完全不发正文页请求**（Legado 在 AnalyzeUrl 之前就 return 了）。
 *      「去抓 mp3 二进制 / 空规则求值为空」的浪费与噪声都来自这一步。
 *
 * 实测来源：🔊潇社音乐（`ruleContent = {}`、`ruleToc.chapterUrl` 是 mp3 直链）——
 * 修前 `content` 返回 `{paragraphs:[]}` ⇒ 音频浮窗「未取到媒体地址」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

/** 目录页：章节链接由 CHAPTER_URL 注入（见 makeSrc） */
let chapterUrl = 'http://cdn.media.test/a1.mp3';
const detailHtml = () =>
  `<html><body><h1>测试书</h1><div class="ch"><a href="${chapterUrl}">第1集</a></div></body></html>`;

let httpCalls: string[] = [];

function makeCtx(): EngineContext {
  httpCalls = [];
  return {
    reqId: 'empty-content-test',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        httpCalls.push(url);
        return { status: 200, headers: { 'content-type': 'text/html' }, body: detailHtml(), url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

/** `content` 传 undefined = 源根本没写 ruleContent；传 '' = 写了但空串 */
function makeSrc(content: string | undefined, bookSourceType: number) {
  const raw: Record<string, unknown> = {
    bookSourceUrl: 'https://media.test',
    bookSourceName: '空正文规则测试源',
    bookSourceType,
    searchUrl: 'https://media.test/search?q={{key}}',
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: '{{baseUrl}}' },
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
  };
  if (content !== undefined) raw['ruleContent'] = { content };
  const out = compileBookSource(raw);
  assert.ok(out.ok && out.rule, 'compile 失败');
  return { rule: out.rule! };
}

async function contentOf(bookSourceType: number, content: string | undefined, chUrl: string) {
  chapterUrl = chUrl;
  const { rule } = makeSrc(content, bookSourceType);
  const engine = new LegadoEngine();
  const ctx = makeCtx();
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: 'https://media.test/book/1' }) }, ctx);
  const ch0 = d.chapters?.[0];
  assert.ok(ch0, '应有章节');
  assert.equal((ch0.payload as { chapterUrl?: string }).chapterUrl, chUrl, '章节链接应被 toc 阶段解析为绝对地址');
  httpCalls = []; // 只统计**正文阶段**的请求
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(ch0.payload) }, ctx);
  return { c, calls: [...httpCalls] };
}

test('BK-① 音频源(1) + ruleContent 缺失 → media 就是章节链接，且不发正文请求', async () => {
  const { c, calls } = await contentOf(1, undefined, 'http://cdn.media.test/a1.mp3');
  assert.equal(c.media?.url, 'http://cdn.media.test/a1.mp3', '应把章节链接当媒体直链');
  assert.equal(calls.length, 0, 'Legado 在 AnalyzeUrl 之前就 return ⇒ 不得发正文页请求');
});

test('BK-② 音频源(1) + content 是空串 → 同上（ruleComplete 的空规则形态）', async () => {
  const { c, calls } = await contentOf(1, '', 'http://cdn.media.test/a2.mp3');
  assert.equal(c.media?.url, 'http://cdn.media.test/a2.mp3');
  assert.equal(calls.length, 0);
});

test('BK-③ 视频源(4) + content 是 "null" → 同上', async () => {
  const { c, calls } = await contentOf(4, 'null', 'https://cdn.media.test/live/master.m3u8');
  assert.equal(c.media?.url, 'https://cdn.media.test/live/master.m3u8');
  assert.equal(c.media?.format, 'm3u8');
  assert.equal(calls.length, 0);
});

test('BK-④ 文本源(0) + 章节链接是网页 → 作为一段正文（与 Legado 一致，不做类型特判）', async () => {
  const { c, calls } = await contentOf(0, undefined, 'http://site.test/read/1.html');
  assert.deepEqual(c.paragraphs, ['http://site.test/read/1.html']);
  assert.equal(calls.length, 0);
});

test('BK-⑤ 图片源(2) + 章节链接是图片 → 作为一张图（懒加载图站常用此形态）', async () => {
  const { c, calls } = await contentOf(2, undefined, 'http://img.test/a1.jpg');
  assert.deepEqual(c.paragraphs, ['http://img.test/a1.jpg']);
  assert.equal(calls.length, 0);
});

test('BK-⑥ 文本源(0) + 章节链接是媒体直链 → 升级为 media（既有「裸直链升级」能力，本次未改语义）', async () => {
  const { c } = await contentOf(0, undefined, 'http://cdn.media.test/a3.mp3');
  assert.equal(c.media?.url, 'http://cdn.media.test/a3.mp3');
});

test('BK-⑦ 非空规则不受影响（照常发正文页请求并按规则求值）', async () => {
  const { c, calls } = await contentOf(1, 'https://other.test/b.mp3', 'http://cdn.media.test/a4.mp3');
  assert.equal(calls.length, 1, '有规则时必须发正文页请求（本次修改不得改变该路径）');
  assert.equal(c.media?.url, 'https://other.test/b.mp3', '规则产物优先于章节链接');
});
