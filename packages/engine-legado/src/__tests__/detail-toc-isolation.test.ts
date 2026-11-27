/**
 * 目录阶段的失败**必须与详情字段隔离**（`#161`，2026-09-29）。
 *
 * ## 现象（用户可见）
 * 详情字段**全部解析成功**，但目录规则一抛错 ⇒ **整条 `detail` 变 `RULE_PARSE@parse`**，
 * `title` / `cover` / `summary` / `wordCount` 一个都不下发。用户看到「详情空 + 目录 0」，
 * 完全看不出「字段其实已经取到了」。
 *
 * 实测（🔞Linpx 系列小说）：
 * ```text
 * [detail] … field:wordCount: rule=textCount ⇒ out=12102   ← 字段有值
 * [detail] … tocUrl: rule=catalogUrl ⇒ out=…/pixiv/series/16165083/cache
 * [ajax] ← 200 len=14 | {"error":true}                     ← 系列内某篇被作者删除
 * ⇒ 接口 error=RULE_PARSE@parse、chapters=0
 * ```
 *
 * ## 上游依据（**两次独立调用**）
 * Legado `WebBook.kt:200 getBookInfoAwait` 与 `WebBook.kt:295 getChapterListAwait`
 * 各自返回自己的 `Result` ⇒ 目录挂了只影响目录，`book` 实体上已写好的字段照样可用。
 *
 * ## 本文件锁四件事
 *  ① **防空转**：目录正常时 ⇒ `chapters` 照常、**没有** `tocError`（证明这条路径本来是通的，
 *     不是「反正都拿不到」）；
 *  ② 目录规则抛错 ⇒ `detail` **不抛**、字段照常、`chapters` 为空数组、`tocError` 非空；
 *  ③ **留痕**（铁律 4）：同时有一条 `warnOnce`，不能静默；
 *  ④ **不保留半截目录**（对齐上游 `analyzeChapterList` 一抛即整体失败）——
 *     收集到一半才抛也要返回空数组，否则半截目录看起来像完整目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  type EngineContext,
  type HttpClient,
  type JsSandboxPool,
} from '@yuedu/core';
import { LegadoEngine } from '../engine';

const noopSandbox: JsSandboxPool = {
  async eval() {
    throw new Error('sandbox 不可用（L1 引擎不用它）');
  },
};

function mockHttp(map: Record<string, string>): HttpClient {
  return {
    async request(url: string) {
      for (const key of Object.keys(map)) {
        if (url.includes(key)) return { status: 200, headers: {}, body: map[key]!, url };
      }
      throw new Error(`no mock for ${url}`);
    },
  };
}

function makeCtx(http: HttpClient): EngineContext {
  return {
    reqId: 't',
    sourceId: 'toc-isolation',
    signal: new AbortController().signal,
    http,
    sandbox: noopSandbox,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

const engine = new LegadoEngine();
const compile = (raw: Record<string, unknown>) => {
  const r = engine.compile(raw);
  assert.ok(r.ok && r.rule, 'compile 应通过');
  return r.rule;
};
const detailReq = { action: 'detail', id: JSON.stringify({ bookUrl: 'https://t.test/book/1' }) } as never;

/** 详情页：书名/作者/简介/封面/最新章节/字数/两章目录齐全 */
const DETAIL_HTML = `<html><body>
  <h1>执子之剑</h1>
  <span class="author">鸠也</span>
  <p class="intro">简介文本</p>
  <img class="cover" src="/img/1.jpg">
  <span class="last">第12话</span>
  <span class="wc">43927</span>
  <ul id="list"><li><a href="/c/1">第1话</a></li><li><a href="/c/2">第2话</a></li></ul>
</body></html>`;

const INFO = {
  name: 'h1@text',
  author: '.author@text',
  intro: '.intro@text',
  coverUrl: '.cover@src',
  lastChapter: '.last@text',
  wordCount: '.wc@text',
};

/** 捕获一次调用里的 console.warn（warnOnce 走 console.warn） */
async function collectWarns<T>(fn: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(' '));
  };
  try {
    return { result: await fn(), warns };
  } finally {
    console.warn = orig;
  }
}

test('① 防空转：目录正常时 chapters 照常、且**没有** tocError', async () => {
  const rule = compile({
    bookSourceUrl: 'https://t.test/',
    bookSourceName: '目录隔离-正常',
    ruleBookInfo: INFO,
    ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
  });
  const r = await engine.detail(rule, detailReq, makeCtx(mockHttp({ '/book/1': DETAIL_HTML })));
  assert.equal((r.chapters ?? []).length, 2, '目录应正常解析出 2 章');
  assert.equal(r.tocError, undefined, '目录成功时**不应**有 tocError');
  assert.equal(r.meta?.['字数'], '43927', '字数应正常');
});

test('② 目录规则抛错 → 详情不抛、字段照常、chapters 空数组、tocError 非空', async () => {
  const rule = compile({
    bookSourceUrl: 'https://t.test/',
    bookSourceName: '目录隔离-抛错',
    ruleBookInfo: INFO,
    // 与 Linpx 同族：对 undefined 取属性 → TypeError（目录段整体炸掉）
    ruleToc: { chapterList: '@js:notExistValue.match(/x/)[0]', chapterName: 'a@text', chapterUrl: 'a@href' },
  });
  const { result: r, warns } = await collectWarns(() =>
    engine.detail(rule, detailReq, makeCtx(mockHttp({ '/book/1': DETAIL_HTML }))),
  );

  // ★ 关键：整条详情**不再**变成 RULE_PARSE —— 字段全部保住
  assert.equal(r.title, '执子之剑', '书名应保住');
  assert.equal(r.subtitle, '鸠也', '作者应保住');
  assert.equal(r.summary, '简介文本', '简介应保住');
  assert.ok(String(r.cover).includes('1.jpg'), `封面应保住：${r.cover}`);
  assert.equal(r.meta?.['最新章节'], '第12话', '最新章节应保住');
  assert.equal(r.meta?.['字数'], '43927', '**字数应保住**（这正是修复前被吞掉的那个字段）');

  assert.deepEqual(r.chapters, [], '目录失败时 chapters 应是**空数组**（不是 undefined）');
  assert.ok(r.tocError && r.tocError.length > 0, `tocError 应写明原因，实际=${JSON.stringify(r.tocError)}`);

  // ③ 留痕
  assert.ok(
    warns.some((w) => w.includes('目录阶段失败')),
    `应有一条 warnOnce 留痕，实际 warns=${JSON.stringify(warns.slice(0, 3))}`,
  );
});

test('④ 收集到一半才抛 → 仍返回空目录（不留半截，半截目录比「空+原因」更危险）', async () => {
  const rule = compile({
    bookSourceUrl: 'https://t.test/',
    bookSourceName: '目录隔离-半途',
    ruleBookInfo: INFO,
    // 第 1 章正常入列；第 2 章求名时抛错 ⇒ collect 在 out 已有 1 项时炸。
    // ⚠️ 判据只能用 `indexOf` / `includes`，**不能用 `===`**：`@js:` 链在 jsoup 段之后时
    // `result` 是 **String 包装对象**（`ObjCtor=String`，实测见 `tmp/r161/server.log` 的
    // `[ajax-in] typeof=string str=false ctor=String`），与原始字符串 `===` 恒为 false
    // ⇒ 条件永不成立、测出来是「没抛错」（我第一版就踩了，A/B/C 三种写法全部静默不触发）。
    ruleToc: {
      chapterList: '#list li',
      chapterName: 'a@text@js:result.indexOf("2")>=0 ? notExistValue.x : result',
      chapterUrl: 'a@href',
    },
  });
  const r = await engine.detail(rule, detailReq, makeCtx(mockHttp({ '/book/1': DETAIL_HTML })));
  assert.equal(r.title, '执子之剑', '书名应保住');
  assert.deepEqual(r.chapters, [], '半途抛错也必须是空数组（不得下发半截目录）');
  assert.ok(r.tocError, 'tocError 应写明原因');
});

test('⑤ 边界：源**没有**目录规则时 → chapters 保持 undefined、tocError 为空（不是失败）', async () => {
  const rule = compile({
    bookSourceUrl: 'https://t.test/',
    bookSourceName: '目录隔离-无规则',
    ruleBookInfo: INFO,
    ruleToc: {},
  });
  const r = await engine.detail(rule, detailReq, makeCtx(mockHttp({ '/book/1': DETAIL_HTML })));
  assert.equal(r.title, '执子之剑', '书名应正常');
  assert.equal(r.chapters, undefined, '「源没配目录规则」应保持 undefined（与「解析失败」区分开）');
  assert.equal(r.tocError, undefined, '没配规则不是失败，不该有 tocError');
});
