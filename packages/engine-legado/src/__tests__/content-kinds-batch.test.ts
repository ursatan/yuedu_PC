/**
 * content 全类型批量实测（阶段 A/B 回归闸门）：文本(0)/图片(2)/音频(1)/视频(4)/文件(3)
 * 覆盖「图片源 content 保留图片 URL」「音频/视频/文件 content 结构化（media.url + format）」。
 * 用 mock http，不依赖真实站点。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

// 单 HTML 同时承载「目录链接(.ch a@href)」与「正文内容」，对任意 URL 都返回它
function makeCtx(html: string): EngineContext {
  return {
    reqId: 'kinds-batch',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        return { status: 200, headers: { 'content-type': 'text/html' }, body: html, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

function makeSrc(bookSourceType: number, contentRule: string) {
  const raw = {
    bookSourceUrl: 'https://k.test',
    bookSourceName: '类型测试源',
    bookSourceType,
    searchUrl: 'https://k.test/search?q={{key}}',
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: '{{baseUrl}}' },
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: contentRule },
  };
  const out = compileBookSource(raw);
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

async function runContent(type: number, contentRule: string, html: string) {
  const rule = makeSrc(type, contentRule);
  const engine = new LegadoEngine();
  const ctx = makeCtx(html);
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: 'https://k.test/book/1' }) }, ctx);
  const ch0 = d.chapters?.[0];
  assert.ok(ch0, '应有章节');
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(ch0.payload) }, ctx);
  return c;
}

const PAGE = (inner: string) => `<html><body><div class="ch"><a href="/ch/1">第1章</a></div>${inner}</body></html>`;

test('content kinds: 文本(0) → 段落为纯文本', async () => {
  const c = await runContent(0, 'class.article@html', PAGE('<div class="article"><p>第一段正文。</p><p>第二段正文。</p></div>'));
  assert.ok(c.paragraphs.length >= 2, `段落数 ${c.paragraphs.length}`);
  assert.match(c.paragraphs.join(''), /正文/);
  assert.equal(c.media, undefined);
});

test('content kinds: 图片(2) → paragraphs 为图片 URL，imageStyle 默认 FULL（阶段A）', async () => {
  const c = await runContent(2, 'class.gallery@html', PAGE('<div class="gallery"><img src="https://img.test/p1.jpg"><img data-src="https://img.test/p2.jpg"></div>'));
  assert.deepEqual(c.paragraphs, ['https://img.test/p1.jpg', 'https://img.test/p2.jpg']);
  assert.equal(c.imageStyle, 'FULL');
  assert.equal(c.media, undefined);
});

test('content kinds: 音频(1) → media.url + format=audio（阶段B）', async () => {
  const c = await runContent(1, 'class.player@html', PAGE('<div class="player"><audio><source src="https://cdn.test/a1.mp3"></audio></div>'));
  assert.equal(c.media?.url, 'https://cdn.test/a1.mp3');
  assert.equal(c.media?.format, 'audio');
});

test('content kinds: 视频(4) → media.url + format=m3u8（阶段B）', async () => {
  const c = await runContent(4, 'https://cdn.test/live.m3u8', PAGE('<div class="ch"><a href="/ch/1">第1集</a></div>'));
  assert.equal(c.media?.url, 'https://cdn.test/live.m3u8');
  assert.equal(c.media?.format, 'm3u8');
});

test('content kinds: 文件(3) → media.url（下载直链），format=unknown（阶段B）', async () => {
  const c = await runContent(3, 'https://dl.test/book.zip', PAGE('<div class="ch"><a href="/ch/1">第1章</a></div>'));
  assert.equal(c.media?.url, 'https://dl.test/book.zip');
  assert.equal(c.media?.format, 'unknown');
});
