/**
 * 分页 P0 形态测试（对齐 Legado 源码语义）：
 *  ① nextTocUrl 返回 URL 数组（BookChapterList: getStringList 多页并发）
 *  ② nextTocUrl 单 URL 链式追页
 *  ③ tocUrl 走规则链（css@attr##正则##替换，BookInfo.kt）
 *  ④ nextContentUrl 返回数组（BookContent: getStringList）
 * mock http，不依赖真实站点。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://pg.test';

function makeCtx(pages: Record<string, string>): EngineContext {
  return {
    reqId: 'pg-test',
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
    bookSourceName: '分页测试源',
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

test('P0①: nextTocUrl 返回 URL 数组 → 并发抓取全部页', async () => {
  const rule = makeSrc({
    ruleBookInfo: { name: 'h1@text', tocUrl: '/book/1/' },
    ruleToc: {
      chapterList: '#list li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
      nextTocUrl: `<js>JSON.stringify(['${BASE}/book/1/p2/', '${BASE}/book/1/p3/'])</js>`,
    },
  });
  const ctx = makeCtx({
    '*': '<html><body><h1>书</h1><ul id="list"></ul></body></html>',
    [`${BASE}/book/1/`]: page([1, 2]),
    [`${BASE}/book/1/p2/`]: page([3, 4]),
    [`${BASE}/book/1/p3/`]: page([5, 6]),
  });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.equal(d.chapters?.length, 6, '三页共 6 章');
  assert.deepEqual(d.chapters?.map((c) => c.title), ['第1章', '第2章', '第3章', '第4章', '第5章', '第6章']);
});

test('P0②: nextTocUrl 单 URL 链式追页（相对链接按当前页解析）', async () => {
  const rule = makeSrc({
    ruleBookInfo: { name: 'h1@text', tocUrl: '/book/2/' },
    ruleToc: {
      chapterList: '#list li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
      nextTocUrl: 'a.next@href', // 相对链接 p2.html
    },
  });
  const ctx = makeCtx({
    '*': '<html><body><h1>书</h1></body></html>',
    [`${BASE}/book/2/`]: `<html><body><ul id="list">${ch(1)}</ul><a class="next" href="p2.html">下一页</a></body></html>`,
    [`${BASE}/book/2/p2.html`]: `<html><body><ul id="list">${ch(2)}</ul></body></html>`,
  });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/2/` }) }, ctx);
  assert.equal(d.chapters?.length, 2, '链式两页共 2 章');
  assert.equal(d.chapters?.[1]?.title, '第2章');
});

test('P0③: tocUrl 规则链 css@attr##正则##替换 → 单独目录页', async () => {
  const rule = makeSrc({
    ruleBookInfo: { name: 'h1@text', tocUrl: "class.cat@onclick##jumpPage\\('(.*?)'\\)##$1" },
  });
  const detailHtml = `<html><body><h1>书</h1><a class="cat" onclick="jumpPage('/toc/9/')">目录</a></body></html>`;
  const ctx = makeCtx({
    '*': '<html><body><h1>书</h1></body></html>',
    [`${BASE}/book/1/`]: detailHtml,
    [`${BASE}/toc/9/`]: page([1, 2, 3]),
  });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.equal(d.chapters?.length, 3, '目录页 3 章');
});

test('P0④: nextContentUrl 返回数组 → 正文多页合并', async () => {
  const rule = makeSrc({
    ruleBookInfo: { name: 'h1@text', tocUrl: '/book/3/' },
    ruleContent: {
      content: '.con@html',
      nextContentUrl: `<js>JSON.stringify(['${BASE}/c/1_2.html'])</js>`,
    },
  });
  const ctx = makeCtx({
    '*': '<html><body><h1>书</h1></body></html>',
    [`${BASE}/book/3/`]: page([1]),
    [`${BASE}/c/1.html`]: '<html><body><div class="con"><p>第一页正文</p></div></body></html>',
    [`${BASE}/c/1_2.html`]: '<html><body><div class="con"><p>第二页正文</p></div></body></html>',
  });
  const engine = new LegadoEngine();
  const d = await engine.detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/3/` }) }, ctx);
  assert.ok(d.chapters?.length, '应有章节');
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(d.chapters![0]!.payload) }, ctx);
  assert.deepEqual(c.paragraphs, ['第一页正文', '第二页正文'], '两页正文合并');
});

// ── `#768` 页 2+ 失败不许静默：页 1 照常返回 + `tocError` 带原因 ─────────────────

/** 和 makeCtx 同形，但指定 URL 的请求抛错（模拟页 2 超时/被拦） */
function makeCtxWithFail(pages: Record<string, string>, failUrls: string[]): EngineContext {
  return {
    ...makeCtx(pages),
    http: {
      async request(url: string): Promise<HttpResponse> {
        if (failUrls.includes(url)) throw new Error('TIMEOUT');
        const body = pages[url] ?? pages['*'] ?? '<html><body></body></html>';
        return { status: 200, headers: { 'content-type': 'text/html' }, body, url };
      },
    },
  };
}

test('#768①: 页 2 抓取失败 → 页 1 章照常返回，tocError 写明原因', async () => {
  const rule = makeSrc({
    ruleBookInfo: { name: 'h1@text', tocUrl: '/book/4/' },
    ruleToc: {
      chapterList: '#list li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
      nextTocUrl: 'a.next@href',
    },
  });
  const ctx = makeCtxWithFail(
    {
      '*': '<html><body><h1>书</h1></body></html>',
      [`${BASE}/book/4/`]: `<html><body><ul id="list">${ch(1)}</ul><a class="next" href="p2.html">下一页</a></body></html>`,
    },
    [`${BASE}/book/4/p2.html`],
  );
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/4/` }) }, ctx);
  assert.equal(d.chapters?.length, 1, '页 1 的章必须保留');
  assert.ok(d.tocError?.includes('下一页抓取失败'), `tocError 应写明抓取失败，实际=${JSON.stringify(d.tocError)}`);
  assert.ok(d.tocError?.includes('TIMEOUT'), '原因里应带底层错误');
});

test('#768②: nextTocUrl 求值失败 → 页 1 章照常返回，tocError 写明原因', async () => {
  const rule = makeSrc({
    ruleBookInfo: { name: 'h1@text', tocUrl: '/book/5/' },
    ruleToc: {
      chapterList: '#list li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
      nextTocUrl: `<js>throw new Error('next boom')</js>`,
    },
  });
  const ctx = makeCtx({
    '*': '<html><body><h1>书</h1></body></html>',
    [`${BASE}/book/5/`]: page([1, 2]),
  });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/5/` }) }, ctx);
  assert.equal(d.chapters?.length, 2, '页 1 的章必须保留');
  assert.ok(d.tocError?.includes('nextTocUrl 求值失败'), `tocError 应写明求值失败，实际=${JSON.stringify(d.tocError)}`);
});

test('#768③: 正常两页 → 无 tocError，章数 = 两页之和', async () => {
  const rule = makeSrc({
    ruleBookInfo: { name: 'h1@text', tocUrl: '/book/6/' },
    ruleToc: {
      chapterList: '#list li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
      nextTocUrl: 'a.next@href',
    },
  });
  const ctx = makeCtx({
    '*': '<html><body><h1>书</h1></body></html>',
    [`${BASE}/book/6/`]: `<html><body><ul id="list">${ch(1)}${ch(2)}</ul><a class="next" href="p2.html">下一页</a></body></html>`,
    [`${BASE}/book/6/p2.html`]: `<html><body><ul id="list">${ch(3)}${ch(4)}</ul></body></html>`,
  });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/6/` }) }, ctx);
  assert.equal(d.chapters?.length, 4, '两页共 4 章');
  assert.equal(d.tocError, undefined, '正常两页不应有 tocError');
});

// ── `#769` 目录后续页的最小独立预算（不被行动剩余预算裁到 1s）────────────────────

/** 记录每个 URL 实际下发的 `opts.timeout` 与是否带 `ctx.signal`（模拟行动预算只剩几百毫秒） */
function makeCtxTimed(
  pages: Record<string, string>,
  deadlineAt?: number,
): { ctx: EngineContext; timeouts: Record<string, number>; signals: Record<string, boolean> } {
  const timeouts: Record<string, number> = {};
  const signals: Record<string, boolean> = {};
  const signal = new AbortController().signal;
  const ctx: EngineContext = {
    reqId: 'pg-timed',
    sourceId: 'test',
    signal,
    ...(deadlineAt ? { deadlineAt } : {}),
    http: {
      async request(url: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<HttpResponse> {
        timeouts[url] = Number(opts?.timeout ?? 0);
        signals[url] = opts?.signal === signal;
        const body = pages[url] ?? pages['*'] ?? '<html><body></body></html>';
        return { status: 200, headers: { 'content-type': 'text/html' }, body, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, timeouts, signals };
}

test('#769①: 行动剩余预算只剩 ~0.8s → 目录页 2 仍拿到 ≥15s 独立预算', async () => {
  const rule = makeSrc({
    ruleBookInfo: { name: 'h1@text', tocUrl: '/book/7/' },
    ruleToc: {
      chapterList: '#list li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
      nextTocUrl: 'a.next@href',
    },
  });
  const p1 = `${BASE}/book/7/`;
  const p2 = `${BASE}/book/7/p2.html`;
  const { ctx, timeouts, signals } = makeCtxTimed(
    {
      '*': '<html><body><h1>书</h1></body></html>',
      [p1]: `<html><body><ul id="list">${ch(1)}</ul><a class="next" href="p2.html">下一页</a></body></html>`,
      [p2]: `<html><body><ul id="list">${ch(2)}</ul></body></html>`,
    },
    Date.now() + 800,
  );
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: p1 }) }, ctx);
  assert.equal(d.chapters?.length, 2, '两页章都要回来（页 2 不能因预算被裁而丢）');
  assert.equal(d.tocError, undefined, '页 2 成功时不应有 tocError');
  assert.ok((timeouts[p1] ?? 0) <= 1_001, `页 1 仍按剩余预算（≤1s），实际=${timeouts[p1]}`);
  assert.ok(
    (timeouts[p2] ?? 0) >= 15_000,
    `页 2 必须拿到 ≥15s 独立预算（不被 deadlineAt 裁到 1s），实际=${timeouts[p2]}`,
  );
  assert.equal(signals[p2], true, '请求必须带 ctx.signal（行动预算到点要能真正中断在途抓取）');
});

test('#769②: 无 deadline → 页 2 仍走默认 60s 上限（下限不把正常请求拉长）', async () => {
  const rule = makeSrc({
    ruleBookInfo: { name: 'h1@text', tocUrl: '/book/8/' },
    ruleToc: {
      chapterList: '#list li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
      nextTocUrl: 'a.next@href',
    },
  });
  const p1 = `${BASE}/book/8/`;
  const p2 = `${BASE}/book/8/p2.html`;
  const { ctx, timeouts } = makeCtxTimed({
    '*': '<html><body><h1>书</h1></body></html>',
    [p1]: `<html><body><ul id="list">${ch(1)}</ul><a class="next" href="p2.html">下一页</a></body></html>`,
    [p2]: `<html><body><ul id="list">${ch(2)}</ul></body></html>`,
  });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: p1 }) }, ctx);
  assert.equal(d.chapters?.length, 2);
  assert.equal(timeouts[p2], 60_000, '无 deadline 时页 2 仍是 60s 上限（与旧行为一致）');
});

