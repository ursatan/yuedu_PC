/**
 * `#643` 回归锁：**「目录规则在、命中 0 条」必须回 `chapters: []`，不能回 `undefined`。**
 *
 * 两种形态在下游完全不同（`UnifiedDetail.chapters` / `tocError` 的契约注释）：
 *  · `chapterList` **为空** ⇒ `undefined` = 源没配目录规则（合法的"无目录"）；
 *  · 规则在但取到 0 条 ⇒ **必须** `[]` = "配了、没解析出章节"。
 *
 * 旧实现两者都返 `undefined` ⇒ `JSON.stringify` 把 `chapters` 键**整个丢掉**
 * ⇒ 前端收到一页没有 `chapters` 字段的详情，既显示不了「目录 0 章」，
 * 也不会走 `tocEmptyHint` 的解释分支，与「源没配目录」无法区分。
 *
 * 实测（`#643` 搬山人 `___www.banshanren.com`）：站点把目录项从
 * `<li class="volume_chapter">` 改成裸 `<li>`，源的 `.chapter_list li.volume_chapter`
 * 命中 0 条 ⇒ 响应里连 `chapters` 键都没有。改为 `[]` 后前端可如实提示。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpRequestOptions, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://toc643.test';
const PAGE = '<html><body><ul class="chapter_list"><li><a href="/c1">第1章</a></li></ul></body></html>';

function makeSrc(toc: Record<string, unknown> | undefined) {
  const out = compileBookSource({
    bookSourceUrl: `${BASE}/`,
    bookSourceName: '目录空回归源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text' },
    ...(toc ? { ruleToc: toc } : {}),
  });
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);
  return out.rule!;
}

function makeCtx(): EngineContext {
  return {
    reqId: 'toc643',
    sourceId: 'toc643',
    signal: new AbortController().signal,
    http: {
      async request(url: string, _o?: HttpRequestOptions): Promise<HttpResponse> {
        return { status: 200, headers: { 'content-type': 'text/html' }, body: PAGE, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

async function detailOf(toc: Record<string, unknown> | undefined) {
  const det = (await new LegadoEngine().detail(
    makeSrc(toc),
    { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1` }) },
    makeCtx(),
  )) as unknown as Record<string, unknown>;
  return det;
}

test('#643 目录选择器命中 0 条 ⇒ chapters 是空数组（键必须在，不能丢）', async () => {
  const det = await detailOf({ chapterList: 'li.volume_chapter', chapterName: 'a@text', chapterUrl: 'a@href' });
  assert.ok('chapters' in det, `chapters 键被 JSON.stringify 丢掉了：keys=${Object.keys(det).join(',')}`);
  assert.ok(Array.isArray(det['chapters']), `chapters 应是数组，实际 ${typeof det['chapters']}`);
  assert.equal((det['chapters'] as unknown[]).length, 0);
  // 反向锁：JSON 序列化后键仍在（前端拿到的就是这份 JSON）
  assert.ok(JSON.parse(JSON.stringify(det))['chapters'] !== undefined, '序列化后 chapters 必须还在');
});

test('#643 对照组：选择器命中 ⇒ 正常出章节（证明上面那条不是因为「目录根本没跑」）', async () => {
  const det = await detailOf({ chapterList: 'ul.chapter_list li', chapterName: 'a@text', chapterUrl: 'a@href' });
  const chs = det['chapters'] as Array<Record<string, unknown>>;
  assert.equal(chs.length, 1, `应 1 章，实际 ${chs.length}：${JSON.stringify(chs)}`);
  assert.equal(chs[0]!['title'], '第1章');
});

test('#643 源没配目录规则时仍是 undefined（不下发空数组，保持"无目录"语义）', async () => {
  const det = await detailOf(undefined);
  // 这条锁的是「不要把 undefined 一律改成 []」——两种形态必须能区分
  assert.equal(det['chapters'], undefined, '未配规则时不应下发 []');
});
