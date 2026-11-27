/**
 * 源级 Cookie jar 测试（对齐 Legado okhttp CookieJar / CookieStore）：
 *  ① 响应 Set-Cookie 回收进源 Cookie，后续请求自动带上 Cookie 头
 *  ② 多条 Set-Cookie（换行分隔）逐条解析
 *  ③ Max-Age=0（删除指令）→ 从 jar 移除
 *  ④ java.cookie.setCookie 写入的 cookie 也随请求发出
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://ck.test';

interface CtxOpts {
  pages: Record<string, string>;
  setCookie?: Record<string, string>; // 指定 URL → Set-Cookie 头
  jar?: Record<string, string>;
  seenCookies?: Array<string | undefined>; // 每次请求的 Cookie 头快照
}

function makeCtx(o: CtxOpts): EngineContext {
  const jar = o.jar ?? {};
  return {
    reqId: 'ck-test',
    sourceId: 'test',
    signal: new AbortController().signal,
    cookies: {
      get: (k) => jar[k] ?? '',
      set: (k, v) => {
        jar[k] = v;
      },
      remove: (k) => {
        delete jar[k];
      },
      header: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    },
    http: {
      async request(url: string, opts?: { headers?: Record<string, string> }): Promise<HttpResponse> {
        o.seenCookies?.push(opts?.headers?.['Cookie']);
        const sc = o.setCookie?.[url];
        const headers: Record<string, string> = { 'content-type': 'text/html' };
        if (sc) headers['set-cookie'] = sc;
        return { status: 200, headers, body: o.pages[url] ?? o.pages['*'] ?? '<html></html>', url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

function makeSrc(over: Record<string, unknown> = {}) {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: 'Cookie 测试源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: `${BASE}/toc/1/` },
    ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.con@html' },
    ...over,
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

const BOOK_HTML = '<html><body><h1>书</h1></body></html>';
const TOC_HTML = '<html><body><ul id="list"><li><a href="/c/1.html">第1章</a></li></ul></body></html>';

test('Cookie①: 详情页下发的 Set-Cookie 会在目录请求时带上', async () => {
  const rule = makeSrc();
  const seenCookies: Array<string | undefined> = [];
  const ctx = makeCtx({
    pages: { [`${BASE}/book/1/`]: BOOK_HTML, [`${BASE}/toc/1/`]: TOC_HTML },
    setCookie: { [`${BASE}/book/1/`]: 'session=abc123; Path=/; HttpOnly\nsid=xyz; Path=/' },
    seenCookies,
  });
  const d = await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.equal(d.chapters?.length, 1, '目录可用');
  // 第 1 次请求（详情页）无 cookie；第 2 次（目录）应带 session/sid
  assert.equal(seenCookies[0], undefined, '首次请求无 Cookie');
  assert.ok(String(seenCookies[1]).includes('session=abc123'), '目录请求带上 Set-Cookie');
  assert.ok(String(seenCookies[1]).includes('sid=xyz'), '多条 Set-Cookie 都要回收');
});

test('Cookie②: Max-Age=0 视为删除', async () => {
  const rule = makeSrc();
  const jar: Record<string, string> = { old: 'stale' };
  const seenCookies: Array<string | undefined> = [];
  const ctx = makeCtx({
    pages: { [`${BASE}/book/1/`]: BOOK_HTML, [`${BASE}/toc/1/`]: TOC_HTML },
    setCookie: { [`${BASE}/book/1/`]: 'old=; Max-Age=0; Path=/\nfresh=1; Path=/' },
    jar,
    seenCookies,
  });
  await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.equal(jar['old'], undefined, 'Max-Age=0 的 cookie 被移除');
  assert.equal(jar['fresh'], '1', '同批其它 cookie 正常写入');
  assert.ok(!String(seenCookies[1]).includes('old='), '后续请求不再带已删除 cookie');
});

test('Cookie③: 源脚本写 cookie（Legado 全局 cookie.setCookie(url, cookie)）随请求发出', async () => {
  const rule = makeSrc({
    ruleToc: {
      chapterList: '#list li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
      // Legado JsExtensions.kt:896 bindings["cookie"] = CookieStore（URL 形态 API）
      preUpdateJs: `cookie.setCookie("${BASE}/", "token=tk-123; uid=9")`,
    },
  });
  const seenCookies: Array<string | undefined> = [];
  const jar: Record<string, string> = {};
  const ctx = makeCtx({
    pages: { [`${BASE}/book/1/`]: BOOK_HTML, [`${BASE}/toc/1/`]: TOC_HTML },
    jar,
    seenCookies,
  });
  await new LegadoEngine().detail(rule as never, { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/book/1/` }) }, ctx);
  assert.equal(jar['token'], 'tk-123', 'cookie 写入源存储');
  assert.equal(jar['uid'], '9', '多条 cookie 一并写入');
  assert.ok(String(seenCookies[1]).includes('token=tk-123'), '目录请求带上脚本设置的 cookie');
});
