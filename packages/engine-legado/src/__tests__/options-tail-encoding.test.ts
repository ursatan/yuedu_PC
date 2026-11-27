/**
 * 回归锁：**,{options} 尾巴被百分号编码后仍必须解析出 method/body**（类别性缺陷）。
 *
 * 实测（点众阅读）：搜索结果 payload 的 bookUrl 是
 *   `https://asgportal.kkyd.cn/asg-portal/portal/client/1111,%7B%22method%22:%20%22post%22,%20body:%20%22c404…%22%7D`
 * 旧实现只还原 `%7B/%7D/%22`，**`%20` 残留** → 宽松解析把键值切成 `%20body` / `%20"post"`
 * → `reqOpts['method']` 取不到 POST → **请求静默退化为 GET** → 站点 405
 * → 详情 `$.bookDetail` 取不到对象 → kind 规则再报 `result.get is not a function`（#76 的表象之一）。
 *
 * 修法：按 `,{` 定位尾巴 → **整体 decodeURIComponent** → 再宽松解析。
 * （Legado `AnalyzeUrl` 收到的尾巴本就是原始 JSON，不存在编码残留。）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpRequestOptions, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://d.test';

function makeSrc(over: Record<string, unknown> = {}) {
  const out = compileBookSource({
    bookSourceUrl: `${BASE}/`,
    bookSourceName: '选项尾巴回归源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'bookName' },
    ...over,
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

/** 记录每次请求的 method / body / url */
function makeCtx() {
  const reqs: Array<{ url: string; method: string; body?: string }> = [];
  const ctx: EngineContext = {
    reqId: 'tail',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string, opts?: HttpRequestOptions): Promise<HttpResponse> {
        const body = typeof opts?.body === 'string' ? opts.body : undefined;
        reqs.push({ url, method: opts?.method ?? 'GET', ...(body !== undefined ? { body } : {}) });
        return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"bookName":"书名"}', url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, reqs };
}

const ENCODED_TAIL = `%7B%22method%22:%20%22post%22,%20body:%20%22abc%22%7D`;

test('选项尾巴被百分号编码：detail 请求必须仍是 POST 且带 body（实测点众阅读 405）', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx();
  await new LegadoEngine().detail(
    rule,
    { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/1,${ENCODED_TAIL}` }) },
    ctx,
  );
  const r = reqs[0];
  assert.ok(r, '必须发出详情请求');
  assert.equal(r.url, `${BASE}/api/1`, `URL 主体必须切掉尾巴：${r.url}`);
  assert.equal(r.method, 'POST', `method 必须解析为 POST（旧实现退化成 GET）：${JSON.stringify(r)}`);
  assert.equal(r.body, 'abc', `body 必须解析出来：${JSON.stringify(r)}`);
});

test('@js: 模板块里的 `,{` 字面量不得被当成选项尾巴切走（否则 JS 源码被截断）', async () => {
  // 实测回归：番茄听书[官方] searchUrl = `@js: … url + ',{"method":"POST","body":' + … '}'`
  //   —— 在整段上切 `,{` 会把 JS 从字符串中间截断 → `Invalid or unexpected token`（搜索 20 → 0）。
  const rule = makeSrc({
    searchUrl: [
      '@js:',
      "var url = 'https://d.test/api/search';",
      "var body = JSON.stringify({ q: key });",
      "url + ',{\"method\":\"POST\",\"body\":' + JSON.stringify(body) + '}'",
    ].join('\n'),
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
  });
  const { ctx, reqs } = makeCtx();
  const s = (await new LegadoEngine().search(rule, { action: 'search', keyword: 'x' }, ctx)) as unknown as {
    items?: unknown[];
  };
  const r = reqs[0];
  assert.ok(r, `必须发出请求（不得因 JS 被截断而报语法错）`);
  assert.equal(r.url, 'https://d.test/api/search', `URL 主体：${r.url}`);
  assert.equal(r.method, 'POST', `JS 返回的尾巴仍要解析出 POST：${JSON.stringify(r)}`);
  assert.equal(r.body, JSON.stringify({ q: 'x' }), `body 要正确：${r.body}`);
  void s;
});

test('未编码的选项尾巴（原有能力）不得被这次修复破坏', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx();
  await new LegadoEngine().detail(
    rule,
    { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/2,{"method":"POST",body:"xyz"}` }) },
    ctx,
  );
  const r = reqs[0];
  assert.equal(r?.url, `${BASE}/api/2`, `URL 主体：${r?.url}`);
  assert.equal(r?.method, 'POST', '明文尾巴仍要能解析出 POST');
  assert.equal(r?.body, 'xyz');
});

/**
 * URL 选项 `js`（Legado `AnalyzeUrl.kt:274-278`）：
 *     `option.getJs()?.let { evalJS(it, url)?.toString()?.let { u -> url = u } }`
 * 即「用一段 JS 改写/构造 URL」，绑定面里 `result` = 当前 URL（源里常见 `'...' + result + '...'`）。
 *
 * 语义要点：**返回 null/undefined 时 URL 必须保持原样** —— 语料里多数 `js` 是纯副作用脚本
 * （`java.toast('正在加载详情页…')`），旧实现整体忽略 `js`，等于「用 JS 拼 URL」的源一律请求错地址。
 */
test('URL 选项 js：返回值必须替换请求 URL（含 result 绑定）', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx();
  await new LegadoEngine().detail(
    rule,
    { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/js1,{"js":"result + '&x=1'"}` }) },
    ctx,
  );
  assert.equal(reqs[0]?.url, `${BASE}/api/js1&x=1`, `js 返回值必须成为新 URL：${reqs[0]?.url}`);
});

test('URL 选项 js：返回 undefined（纯副作用脚本）时 URL 不得被改坏', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx();
  await new LegadoEngine().detail(
    rule,
    { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/js2,{"js":"java.toast('hi')"}` }) },
    ctx,
  );
  assert.equal(reqs[0]?.url, `${BASE}/api/js2`, `副作用脚本不得改动 URL：${reqs[0]?.url}`);
});

test('URL 选项 js：可用 JS 直接构造绝对 URL（相对结果仍会被绝对化）', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx();
  await new LegadoEngine().detail(
    rule,
    { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/js3,{"js":"'${BASE}/built'"}` }) },
    ctx,
  );
  assert.equal(reqs[0]?.url, `${BASE}/built`, `JS 构造的绝对 URL：${reqs[0]?.url}`);

  const { ctx: ctx2, reqs: reqs2 } = makeCtx();
  await new LegadoEngine().detail(
    rule,
    { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/js4,{"js":"'book?from=js'"}` }) },
    ctx2,
  );
  assert.equal(reqs2[0]?.url, `${BASE}/book?from=js`, `相对结果必须绝对化：${reqs2[0]?.url}`);
});

test('URL 选项 js：脚本抛错时保留原 URL 且请求照发（兜底必须留痕）', async () => {
  const rule = makeSrc();
  const { ctx, reqs } = makeCtx();
  await new LegadoEngine().detail(
    rule,
    { action: 'detail', id: JSON.stringify({ bookUrl: `${BASE}/api/js5,{"js":"throw new Error('boom')"}` }) },
    ctx,
  );
  assert.equal(reqs[0]?.url, `${BASE}/api/js5`, `抛错必须保留原 URL：${reqs[0]?.url}`);
});
