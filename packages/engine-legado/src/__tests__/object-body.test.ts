/**
 * 缺陷类BM 回归锁：**URL 选项 `,{ "body": {…} }` 的「对象体」不能被丢弃**。
 *
 * 依据 Legado `UrlOption.getBody()`：体不是字符串时走 `JsonUtils.toJson(body)` 序列化后再发。
 * 我们此前只认字符串体（`typeof reqOpts.body === 'string'`）⇒ 对象体**静默变成「无体」POST**。
 *
 * 实测来源（2026-09-27 第十七批）`🏷QB女生` / `🏷QQ浏览器` 的 `ruleToc.chapterUrl`：
 * 腾讯小说 `novel.html5.qq.com/be-api/content/ads-read` 必须带
 * `{"Scene":"chapter","ContentAnchorBatch":[{"BookID":"…","ChapterSeqNo":[1]}]}`：
 *   · 引擎（体被丢）→ **400 `{"ret":400,"errMsg":"invalid Request Param"}`** ⇒ 2170 章正文全空
 *   · 同 URL + 体用 curl 手发 → **200** + `{"ret":0,…}` ✅  ⇒ 不是站点问题
 *
 * 语料命中 6 源：`ruleToc.chapterUrl` 2 · `ruleToc.chapterList` 1 · `ruleBookInfo.tocUrl` 1 · `exploreUrl` 2。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpRequestOptions, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

/** 记录每一次出站请求的 (url, method, body, headers) */
let sent: Array<{ url: string; method?: string; body?: string; headers?: Record<string, string> }> = [];

const TOC = '<html><body><div class="ch"><a href="http://site.test/c/1">第1章</a></div></body></html>';
const CONTENT_JSON =
  '{"ret":0,"data":{"Content":[{"ChapterInfo":{"Title":"第1章","Content":"<p>正文第一段</p><p>正文第二段</p>"}}]}}';

function makeCtx(): EngineContext {
  sent = [];
  return {
    reqId: 'object-body-test',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
        sent.push({
          url,
          ...(opts.method ? { method: opts.method } : {}),
          ...(typeof opts.body === 'string' ? { body: opts.body } : {}),
          ...(opts.headers ? { headers: opts.headers } : {}),
        });
        if (/ads-read/.test(url)) {
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: CONTENT_JSON,
            url,
          };
        }
        return { status: 200, headers: { 'content-type': 'text/html' }, body: TOC, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

/** 章节链接 = 「对象体」POST 端点（与 QB女生 同形态：`method`/`body`/`headers` 三个选项） */
const CHAPTER_URL =
  'http://site.test/ads-read,{"method": "POST", "body": {"Scene": "chapter", "ContentAnchorBatch": [{"BookID": "1", "ChapterSeqNo": [1]}]}, "headers": {"Q-GUID": "abc"}}';

function makeSrc(): Record<string, unknown> {
  return {
    bookSourceUrl: 'http://site.test',
    bookSourceName: '对象体测试源',
    bookSourceType: 0,
    searchUrl: 'http://site.test/search?q={{key}}',
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: '{{baseUrl}}' },
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '$.data.Content[0].ChapterInfo.Content' },
  };
}

/** 改一个字段并重新编译（章节链接由 toc 规则产出，第 3 个用例换成静态 URL） */
function compileWith(patch: Record<string, unknown>) {
  const out = compileBookSource({ ...makeSrc(), ...patch });
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

test('BM-① 对象体：POST 必须带上 JSON 序列化后的体（QB女生 形态）', async () => {
  const rule = compileWith({});
  const engine = new LegadoEngine();
  const ctx = makeCtx();
  // toc 阶段的章节链接直接由 detail 的 tocUrl 页面给出 —— 这里让 a@href 指向对象体端点
  const d = await engine.detail(
    rule as never,
    { action: 'detail', id: JSON.stringify({ bookUrl: 'http://site.test/book/1' }) },
    ctx,
  );
  const ch0 = d.chapters?.[0];
  assert.ok(ch0, '应有章节');
  // 把章节链接换成「对象体 POST 端点」，模拟源里 `chapterUrl` 写成带体选项的形态
  const payload = { ...(ch0.payload as Record<string, unknown>), chapterUrl: CHAPTER_URL };

  sent = [];
  await engine.content(rule as never, { action: 'content', id: JSON.stringify(payload) }, ctx);
  const req = sent.find((r) => /ads-read/.test(r.url));
  assert.ok(req, `应请求 ads-read（实际请求：${JSON.stringify(sent.map((s) => s.url))}）`);
  assert.equal(req.method, 'POST', '方法应为 POST');
  assert.ok(req.body, '★ 对象体不得被丢弃：body 必须存在');
  assert.deepEqual(
    JSON.parse(req.body as string),
    { Scene: 'chapter', ContentAnchorBatch: [{ BookID: '1', ChapterSeqNo: [1] }] },
    '体应是源的 JSON 对象逐字序列化',
  );
  assert.equal(req.headers?.['content-type'], 'application/json', 'JSON 体应补 application/json');
  assert.equal(req.headers?.['Q-GUID'], 'abc', '选项里的自定义头应带上');
});

test('BM-② 对象体取到的正文能正常解析出段落', async () => {
  const rule = compileWith({});
  const engine = new LegadoEngine();
  const ctx = makeCtx();
  const d = await engine.detail(
    rule as never,
    { action: 'detail', id: JSON.stringify({ bookUrl: 'http://site.test/book/1' }) },
    ctx,
  );
  const ch0 = d.chapters?.[0];
  assert.ok(ch0);
  const payload = { ...(ch0.payload as Record<string, unknown>), chapterUrl: CHAPTER_URL };
  const c = await engine.content(rule as never, { action: 'content', id: JSON.stringify(payload) }, ctx);
  assert.deepEqual(c.paragraphs, ['正文第一段', '正文第二段'], '正文应能按规则取到（此前恒为空）');
});

test('BM-③ 字符串体行为不变（防回归：原样发送，不做 JSON 包裹）', async () => {
  const rule = compileWith({});
  const engine = new LegadoEngine();
  const ctx = makeCtx();
  const d = await engine.detail(
    rule as never,
    { action: 'detail', id: JSON.stringify({ bookUrl: 'http://site.test/book/1' }) },
    ctx,
  );
  const ch0 = d.chapters?.[0];
  assert.ok(ch0);
  const payload = {
    ...(ch0.payload as Record<string, unknown>),
    chapterUrl: 'http://site.test/ads-read,{"method":"POST","body":"a=1&b=2"}',
  };
  sent = [];
  await engine.content(rule as never, { action: 'content', id: JSON.stringify(payload) }, ctx);
  const req = sent.find((r) => /ads-read/.test(r.url));
  assert.ok(req);
  assert.equal(req.body, 'a=1&b=2', '字符串体原样发送');
  assert.equal(req.headers?.['content-type'], 'application/x-www-form-urlencoded', '表单体默认头不变');
});
