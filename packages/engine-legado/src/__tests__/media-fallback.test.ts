/**
 * 「媒体直链兜底提取」回归锁（2026-09-24，B 项）。
 *
 * ## 背景
 * 视频/音频源常把播放地址放在**页面里的 JS 变量或 JSON**（播放器配置 `player_aaaa`、
 * `url_next`、`"file":"…"`）。原来的兜底是「**第一个绝对 URL**」—— 真实播放页上那通常是
 * css/js/图片 CDN，**必然取错**，用户症状 = 「未取到媒体地址」。
 *
 * 现在按**可信度**排序取（`collectMediaCandidates`）：
 *   ① `<video|audio|source>` 的 src/data-*
 *   ② 播放器常见变量 / JSON 键（值必须像媒体地址）
 *   ③ 规则字面量
 *   ④ 裸的媒体扩展名 URL（含 query 里的 `.m3u8`）
 *   ⑤ 任意绝对 URL（历史行为，最低优先级）
 *
 * 本测试逐条锁住；另外锁 `inferPlayFormat` 对「路径无扩展名、query 里带 .m3u8」的判定
 * （🎬🔞麻豆传媒AI：`https://mdcmai4.xyz/api/v1/m3u8/proxy?path=…/x.m3u8`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createMemoryKeyValueStore, createTraceSink, createVariableStore } from '@yuedu/core';

import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';

const BASE = 'https://media.test';

function makeCtx(): EngineContext {
  return {
    reqId: 'media-test',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        return { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body>play</body></html>', url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

/** 视频源（type=4）；`content` 规则直接产出给定 HTML（用 JS 字面量，避免额外依赖选择器） */
function makeRule(html: string) {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '媒体兜底测试',
    bookSourceType: 4,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text' },
    ruleToc: { chapterList: '#l li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: `@js:${JSON.stringify(html)}` },
  });
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);
  return out.rule!;
}

async function mediaOf(html: string): Promise<{ url?: string; format?: string }> {
  const c = (await new LegadoEngine().content(
    makeRule(html),
    { action: 'content', id: JSON.stringify({ chapterUrl: `${BASE}/play/1`, title: '第1集' }) },
    makeCtx(),
  )) as unknown as { media?: { url?: string; format?: string } };
  return c.media ?? {};
}

test('① 媒体标签优先：页面前面有 css/js 垃圾 URL 时，仍取 <video src>', async () => {
  const { url } = await mediaOf(
    `<html><head><link href="https://cdn.test/a.css"><script src="https://cdn.test/b.js"></script></head>
     <body><video src="https://cdn.test/movie/index.m3u8" controls></video></body></html>`,
  );
  assert.equal(url, 'https://cdn.test/movie/index.m3u8');
});

test('① 懒加载播放器：<video data-src> 也认', async () => {
  const { url } = await mediaOf(`<video data-src="https://cdn.test/lazy/movie.mp4"></video>`);
  assert.equal(url, 'https://cdn.test/lazy/movie.mp4');
});

test('② 播放器变量：JSON 里的转义 URL 必须还原（url_next / file / player_aaaa）', async () => {
  const { url } = await mediaOf(
    `<html><body>
       <img src="https://img.test/cover.jpg">
       <script>var player_aaaa={"flag":"play","file":"https:\\/\\/cdn.test\\/hls\\/index.m3u8","url_next":"https:\\/\\/cdn.test\\/next.m3u8"};</script>
     </body></html>`,
  );
  assert.equal(url, 'https://cdn.test/hls/index.m3u8', '反斜杠必须被还原，且优先 file 而不是 url_next');
});

test('② 变量值不像媒体地址时不得误取（例如 src: "a.js"）', async () => {
  const { url } = await mediaOf(
    `<html><body><script>var cfg={"src":"https://cdn.test/app.js","url":"https://cdn.test/theme.css"};</script>
     <video src="https://cdn.test/real.mp4"></video></body></html>`,
  );
  assert.equal(url, 'https://cdn.test/real.mp4', 'js/css 不能被当播放地址');
});

test('④ 裸媒体 URL：路径无扩展名但 query 带 .m3u8（麻豆传媒AI 形态）', async () => {
  const { url, format } = await mediaOf(
    `<html><body>
       <img src="https://img.test/poster.jpg">
       <script>var p="https://mdcmai4.test/api/v1/m3u8/proxy?path=jpd%2F20260714%2Fmt%2Ff6%2Fpu%2F207e9d23efea4e3fa70fef9b24687f4a.m3u8";</script>
     </body></html>`,
  );
  assert.equal(
    url,
    'https://mdcmai4.test/api/v1/m3u8/proxy?path=jpd%2F20260714%2Fmt%2Ff6%2Fpu%2F207e9d23efea4e3fa70fef9b24687f4a.m3u8',
  );
  assert.equal(format, 'm3u8', 'pathname 无扩展名时要看整串（inferPlayFormat 已补）');
});

test('⑤ 兜底：什么都没有时退回「第一个绝对 URL」（保持历史行为）', async () => {
  const { url } = await mediaOf(`<html><body><a href="https://cdn.test/page.html">x</a></body></html>`);
  assert.equal(url, 'https://cdn.test/page.html');
});

test('⑤ 优先级顺序：②（变量）胜过 ④（裸媒体 URL）', async () => {
  const { url } = await mediaOf(
    `<html><body><video src="https://cdn.test/tag.mp4"></video>
       <script>var file="https://cdn.test/from-var.m3u8";</script>
       <span>https://cdn.test/bare.m3u8</span></body></html>`,
  );
  assert.equal(url, 'https://cdn.test/tag.mp4', '标签 > 变量 > 裸 URL');
});

test('★ 文本源（type=0）里只有一段裸 m3u8 → 必须升级为 media（麻豆传媒AI 形态）', async () => {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '文本源-裸直链',
    bookSourceType: 0, // ← 站点把它标成「文本」，但正文就是一个 m3u8 直链
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text' },
    ruleToc: { chapterList: '#l li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: {
      content: `@js:${JSON.stringify('https://mdcmai4.test/api/v1/m3u8/proxy?path=jpg%2F20260508%2Fhz%2Ff55a885a36cb4a148e07f4aa14cea6eb.m3u8')}`,
    },
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  const c = (await new LegadoEngine().content(
    out.rule!,
    { action: 'content', id: JSON.stringify({ chapterUrl: `${BASE}/play/1`, title: '第1集' }) },
    makeCtx(),
  )) as unknown as { paragraphs?: string[]; media?: { url?: string; format?: string } };
  assert.equal(c.paragraphs?.length ?? 0, 0, '升级为 media 后不应再留文本段落');
  assert.match(c.media?.url ?? '', /f55a885a36cb4a148e07f4aa14cea6eb\.m3u8$/);
  assert.equal(c.media?.format, 'm3u8');
});

test('★ 反向：正常正文（多段文本）不得被误判成 media', async () => {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '文本源-正常正文',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text' },
    ruleToc: { chapterList: '#l li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: `@js:${JSON.stringify('<p>第一段。</p><p>第二段。</p>')}` },
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  const c = (await new LegadoEngine().content(
    out.rule!,
    { action: 'content', id: JSON.stringify({ chapterUrl: `${BASE}/c/1`, title: '第1章' }) },
    makeCtx(),
  )) as unknown as { paragraphs?: string[]; media?: { url?: string } };
  assert.equal(c.media, undefined, '多段正文不该被当成媒体');
  assert.deepEqual(c.paragraphs, ['第一段。', '第二段。']);
});
