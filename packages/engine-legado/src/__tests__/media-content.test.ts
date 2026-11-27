/**
 * 媒体 content 单元测试：音频(1)/文件(3)/视频(4) 源的 content() media 提取
 * ——mock http，不依赖真实站点。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const DETAIL_HTML = '<html><body><h1>测试有声书</h1><div class="ch"><a href="/ch/1">第1集</a></div></body></html>';

function makeCtx(responses: Record<string, string>): EngineContext {
  return {
    reqId: 'media-test',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        const body = responses[url] ?? responses['*'] ?? DETAIL_HTML;
        return { status: 200, headers: { 'content-type': 'text/html' }, body, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

function makeSrc(contentRule: string, bookSourceType: number = 1): { rule: NonNullable<ReturnType<typeof compileBookSource>['rule']> } {
  const raw = {
    bookSourceUrl: 'https://media.test',
    bookSourceName: '媒体测试源',
    bookSourceType,
    searchUrl: 'https://media.test/search?q={{key}}',
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: '{{baseUrl}}' },
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: contentRule },
  };
  const out = compileBookSource(raw);
  assert.ok(out.ok && out.rule, 'compile 失败');
  return { rule: out.rule! };
}

test('media content: 纯 URL 行 → media.url', async () => {
  const { rule } = makeSrc('https://cdn.media.test/a1.mp3');
  const engine = new LegadoEngine();
  const ctx = makeCtx({ '*': DETAIL_HTML });
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: 'https://media.test/book/1' }) }, ctx);
  const ch0 = d.chapters?.[0];
  assert.ok(ch0, '应有章节');
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(ch0.payload) }, ctx);
  assert.equal(c.media?.url, 'https://cdn.media.test/a1.mp3');
});

test('media content: url,{headers json} → url 与 headers 分离', async () => {
  const { rule } = makeSrc('https://cdn.media.test/a2.m4a,{"headers":{"Referer":"https://media.test/"}}');
  const engine = new LegadoEngine();
  const ctx = makeCtx({});
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: 'https://media.test/book/1' }) }, ctx);
  const ch0 = d.chapters?.[0];
  assert.ok(ch0, '应有章节');
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(ch0.payload) }, ctx);
  assert.equal(c.media?.url, 'https://cdn.media.test/a2.m4a');
  assert.equal(c.media?.headers?.['Referer'], 'https://media.test/');
});

test('media content: <audio> 标签 HTML → 提取 src', async () => {
  const { rule } = makeSrc('class.player@html');
  const engine = new LegadoEngine();
  const ctx = makeCtx({
    'https://media.test/ch/1': '<html><body><div class="ch"><a href="/ch/1">第1集</a></div>'
      + '<audio class="player"><source src="https://cdn.media.test/a3.mp3"></audio></body></html>',
  });
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: 'https://media.test/book/1' }) }, ctx);
  const ch0 = d.chapters?.[0];
  assert.ok(ch0, '应有章节');
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(ch0.payload) }, ctx);
  assert.equal(c.media?.url, 'https://cdn.media.test/a3.mp3');
});

test('media content: 相对 URL 绝对化', async () => {
  const { rule } = makeSrc('/media/a4.mp3');
  const engine = new LegadoEngine();
  const ctx = makeCtx({});
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: 'https://media.test/book/1' }) }, ctx);
  const ch0 = d.chapters?.[0];
  assert.ok(ch0, '应有章节');
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(ch0.payload) }, ctx);
  assert.equal(c.media?.url, 'https://media.test/media/a4.mp3');
});

test('media content: mp3 直链 → format=audio', async () => {
  const { rule } = makeSrc('https://cdn.media.test/a1.mp3');
  const engine = new LegadoEngine();
  const ctx = makeCtx({ '*': DETAIL_HTML });
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: 'https://media.test/book/1' }) }, ctx);
  const ch0 = d.chapters?.[0];
  assert.ok(ch0, '应有章节');
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(ch0.payload) }, ctx);
  assert.equal(c.media?.url, 'https://cdn.media.test/a1.mp3');
  assert.equal(c.media?.format, 'audio');
});

test('media content: m3u8 / mp4 直链 → format 正确推断', async () => {
  const mp4 = makeSrc('https://cdn.media.test/v1.mp4');
  const m3u8 = makeSrc('https://cdn.media.test/live.m3u8');
  const engine = new LegadoEngine();
  const ctx = makeCtx({ '*': DETAIL_HTML });
  const d1 = await engine.detail(mp4.rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: 'https://media.test/book/1' }) }, ctx);
  const ch1 = d1.chapters?.[0];
  assert.ok(ch1, '应有章节');
  const c1 = await engine.content(mp4.rule as never, { action: 'content', id: JSON.stringify(ch1.payload) }, ctx);
  assert.equal(c1.media?.format, 'mp4');
  const d2 = await engine.detail(m3u8.rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: 'https://media.test/book/1' }) }, ctx);
  const ch2 = d2.chapters?.[0];
  assert.ok(ch2, '应有章节');
  const c2 = await engine.content(m3u8.rule as never, { action: 'content', id: JSON.stringify(ch2.payload) }, ctx);
  assert.equal(c2.media?.format, 'm3u8');
});

test('image content: <img> 标签 HTML → paragraphs 为图片 URL，imageStyle 默认 FULL', async () => {
  const { rule } = makeSrc('class.gallery@html', 2);
  const engine = new LegadoEngine();
  const ctx = makeCtx({
    'https://media.test/ch/1': '<html><body><div class="ch"><a href="/ch/1">第1页</a></div>'
      + '<div class="gallery"><img src="https://img.test/p1.jpg"><img data-src="https://img.test/p2.jpg"></div></body></html>',
  });
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: 'https://media.test/book/1' }) }, ctx);
  const ch0 = d.chapters?.[0];
  assert.ok(ch0, '应有章节');
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(ch0.payload) }, ctx);
  assert.deepEqual(c.paragraphs, ['https://img.test/p1.jpg', 'https://img.test/p2.jpg']);
  assert.equal(c.imageStyle, 'FULL');
  assert.equal(c.media, undefined);
});

test('image content: 字面图片 URL 作为 content 规则 → paragraphs 直接为该 URL', async () => {
  const { rule } = makeSrc('https://img.test/c1.jpg', 2);
  const engine = new LegadoEngine();
  const ctx = makeCtx({});
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: 'https://media.test/book/1' }) }, ctx);
  const ch0 = d.chapters?.[0];
  assert.ok(ch0, '应有章节');
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(ch0.payload) }, ctx);
  assert.equal(c.paragraphs[0], 'https://img.test/c1.jpg');
  assert.equal(c.imageStyle, 'FULL');
});

