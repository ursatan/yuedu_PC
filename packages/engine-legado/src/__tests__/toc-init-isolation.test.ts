/**
 * 回归锁：#73 —— `ruleBookInfo.init` 改写的内容**不得**泄漏到目录阶段。
 *
 * 背景（Legado 语义）：`BookInfo` 与 `BookChapterList` 是**两个独立阶段**，各自持有内容。
 *   · 详情阶段：`ruleBookInfo.init` 可改写内容（常见形态：把加密的 `$.data` 解密后 setContent）
 *   · 目录阶段：重新取 `book.tocUrl.ifEmpty { book.bookUrl }` 的响应，跑 `ruleToc.*`（可有自己的 init）
 * 我们早期让目录阶段复用 init 改写后的内容 → 当「init 与 chapterList 是同一段解密脚本」时，
 * 第二次解密必然失败（对已解密的对象再取 `$.data`）→ 目录 0 章。
 *
 * 实测案例：全免漫画（`https___api-cdn.kaimanhua.com_`），修复前 chapters=0，修复后 **50 章**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://toc-init.test';

function makeCtx(pages: Record<string, string>): EngineContext {
  return {
    reqId: 'toc-init',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        const body = pages[url] ?? pages['*'] ?? '{}';
        return { status: 200, headers: { 'content-type': 'application/json' }, body, url };
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
    bookSourceUrl: `${BASE}/`,
    bookSourceName: 'init 目录测试源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: '' },
    ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.con@html' },
    ...over,
  };
  const out = compileBookSource(raw);
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

const BOOK_URL = `${BASE}/book/1`;
/** 站点原始响应：`$.data` 是需要「二次加工」的负载（模拟加密体） */
const RAW_BODY = JSON.stringify({
  status: 1,
  data: {
    comic_name: '解密后书名',
    chapters: [
      { chapter_name: '第一话', chapter_id: '1' },
      { chapter_name: '第二话', chapter_id: '2' },
      { chapter_name: '第三话', chapter_id: '3' },
    ],
  },
});

test('#73 目录阶段必须基于「原始响应」，而不是 ruleBookInfo.init 改写后的内容', async () => {
  const rule = makeSrc({
    // init 把内容换成 $.data（模拟解密后 setContent）→ 之后 name 规则对**新内容**求值
    ruleBookInfo: { name: '$.comic_name', init: '$.data', tocUrl: '' },
    // chapterList 又要 `$.data` —— 只有「原始响应」才有这个键
    ruleToc: { chapterList: '$.data.chapters[*]', chapterName: '$.chapter_name', chapterUrl: '$.chapter_id' },
  });
  const r = await new LegadoEngine().detail(rule, { action: 'detail', id: JSON.stringify({ bookUrl: BOOK_URL }) }, makeCtx({ [BOOK_URL]: RAW_BODY }));

  assert.equal(r.title, '解密后书名', 'name 规则应对 init 改写后的内容求值');
  assert.equal(r.chapters?.length, 3, `目录应基于原始响应解析（期望 3 章，实际 ${r.chapters?.length}）`);
  assert.equal(r.chapters?.[0]?.title, '第一话');
});

test('#73 无 init 的源行为不变（回归保护）', async () => {
  const html = '<html><body><ul id="list"><li><a href="/c/1.html">第1章</a></li></ul></body></html>';
  const rule = makeSrc({ ruleBookInfo: { name: 'h1@text', tocUrl: '' } });
  const r = await new LegadoEngine().detail(rule, { action: 'detail', id: JSON.stringify({ bookUrl: BOOK_URL }) }, makeCtx({ [BOOK_URL]: html }));
  assert.equal(r.chapters?.length, 1, '无 init 时目录不受影响');
});
