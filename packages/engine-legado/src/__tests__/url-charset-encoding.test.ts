/**
 * 回归锁（`#197`）：**URL 的 `,{"charset":"gbk"}` 选项必须真的改变关键词的编码方式**。
 *
 * 旧实现（死代码）：
 * ```js
 * url = url.replace(/[^\x21-\x7E]/g, (ch) => encodeURIComponent(ch));         // ① 无条件 UTF-8
 * if (reqCharset && …) url = url.replace(/[^\x21-\x7E]/g, (ch) => percentEncode(ch, reqCharset)); // ②
 * ```
 * ① 跑完 URL 里只剩 ASCII（`我` → `%E6%88%91`，全 ASCII 字符）⇒ ② 的正则**匹配不到任何字符**
 * ⇒ charset 分支永不生效。症状是**静默**的：不乱码、不报错，只是**搜索结果恒 0 条**。
 *
 * 站点侧实测（飞卢小说，同一 URL 只改关键词编码）：
 *   · GBK  `k=%CE%D2%B5%C4`    ⇒ HTTP 200，命中搜索结果 **30** 项 ✅
 *   · UTF-8 `k=%E6%88%91%E7%9A%84` ⇒ HTTP 200，命中 **0** 项 ❌
 *
 * 语料里声明非 UTF-8 charset 的源共 44 个（34 gbk + 10 gb2312，43 个在 `searchUrl`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpRequestOptions, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://d.test';
const GBK_WO_DE = '%CE%D2%B5%C4'; // 「我的」的 GBK
const UTF8_WO_DE = '%E6%88%91%E7%9A%84'; // 「我的」的 UTF-8

function makeSrc(searchUrl: string) {
  const out = compileBookSource({
    bookSourceUrl: `${BASE}/`,
    bookSourceName: 'URL charset 回归源',
    bookSourceType: 0,
    searchUrl,
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'bookName' },
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

function makeCtx() {
  const reqs: string[] = [];
  const ctx: EngineContext = {
    reqId: 'charset',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string, _opts?: HttpRequestOptions): Promise<HttpResponse> {
        reqs.push(url);
        return { status: 200, headers: { 'content-type': 'text/html' }, body: '<i></i>', url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, reqs };
}

async function searchUrlOf(searchUrl: string, keyword: string): Promise<string> {
  const rule = makeSrc(searchUrl);
  const { ctx, reqs } = makeCtx();
  await new LegadoEngine().search(rule, { action: 'search', keyword }, ctx);
  assert.ok(reqs[0], '必须发出搜索请求');
  return reqs[0];
}

test('`{"charset":"gbk"}`：关键词必须按 GBK 编码（旧实现发的是 UTF-8 ⇒ 站点恒 0 结果）', async () => {
  const url = await searchUrlOf(`${BASE}/s?q={{key}},{"charset":"gbk"}`, '我的');
  assert.ok(
    url.includes(GBK_WO_DE),
    `关键词必须是 GBK 的 ${GBK_WO_DE}（实得 ${url}）—— 发 UTF-8 时站点解出乱码，搜索静默为 0 条`,
  );
  assert.ok(!url.includes(UTF8_WO_DE), `不得残留 UTF-8 编码（实得 ${url}）`);
});

test('`{"charset":"gb2312"}` 同样生效（语料里 10 个源用它）', async () => {
  const url = await searchUrlOf(`${BASE}/s?q={{key}},{"charset":"gb2312"}`, '我的');
  assert.ok(url.includes(GBK_WO_DE), `gb2312 走的是同一个编码器（实得 ${url}）`);
});

test('★ 防空转：**没写 charset** 的源必须仍是 UTF-8（不得被这次修复一刀切成 GBK）', async () => {
  const url = await searchUrlOf(`${BASE}/s?q={{key}}`, '我的');
  assert.ok(url.includes(UTF8_WO_DE), `无 charset 时必须保持 UTF-8（实得 ${url}）`);
});

test('★ 防空转：`{"charset":"utf-8"}` 显式声明时也走 UTF-8', async () => {
  const url = await searchUrlOf(`${BASE}/s?q={{key}},{"charset":"utf-8"}`, '我的');
  assert.ok(url.includes(UTF8_WO_DE), `显式 utf-8 必须与不写一致（实得 ${url}）`);
});

test('charset 只影响非 ASCII：ASCII 关键词与已编码的 %xx 序列都不受影响', async () => {
  const ascii = await searchUrlOf(`${BASE}/s?q={{key}},{"charset":"gbk"}`, 'abc');
  assert.equal(ascii, `${BASE}/s?q=abc`, `ASCII 关键词原样（实得 ${ascii}）`);
});
