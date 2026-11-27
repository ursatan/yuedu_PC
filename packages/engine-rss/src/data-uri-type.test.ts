/**
 * `#408(a)` **URL 选项 `type` ⇒ 响应体按字节 hex**（Legado data-URI 方案）。
 *
 * 上游依据（逐行核实，不猜测）：`AnalyzeUrl.kt:461-463`
 * ```kotlin
 * if (type != null) {
 *     return StrResponse(url, HexUtil.encodeHexStr(getByteArrayAwait()))
 * }
 * ```
 * 该分支**先于** WebView / charset 解码返回。`getByteArrayAwait()` 对 `data:` URL 走
 * `getByteArrayIfDataUri()`（`AnalyzeUrl.kt:683-694`，正则 `^data:.*?;base64,(.*)`）——
 * **解出的字节就是「响应体」**。
 *
 * 18AV（WebView 型订阅源，用户语料）的用法：分类/搜索/链接的值形如
 * `data:;base64,<b64(路径)>,{"type":"18av"}`，base64 里是**路径字符串**
 * （`startJs` 自己 `java.base64Encode("/zh/chinese_list/all/"+page+".html")`）。
 * 源规则再 `java.hexDecodeToString(result)` 还原路径、拼 `surl()` 后自行请求。
 *
 * 不实现这条时的症状：本引擎把 `data:...` 当普通文本 URL 交给 HTTP 层（不取 arraybuffer），
 * 规则拿到的 `result` 不是 hex ⇒ `hexDecodeToString` 抛 Illegal hexadecimal character ⇒
 * 分类/列表整链失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTraceSink, createVariableStore, type EngineContext, type HttpClient, type HttpResponse } from '@yuedu/core';
import { RssEngine } from './engine';
import { buildFeedRequest, makeRssEnv } from './env';
import { compileRssSource, type RssSourceRaw } from './model/rss-source';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

/** 18AV 的「中文字幕」分类模板（逐字取自用户源：`sortUrl` 的一条） */
const SORT_TPL = '中文字幕::data:;base64,{{java.base64Encode("/zh/chinese_list/all/"+page+".html")}},{"type":"18av"}';

function makeCtx(http: HttpClient): EngineContext {
  return {
    reqId: 't',
    sourceId: '18av.test',
    signal: new AbortController().signal,
    http,
    // worker 池不可用 ⇒ 走 L1 同步求值（与 #341 同款；本组用例的规则无 java.ajax，L1 足够）
    sandbox: { async eval() { return undefined; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: { async get() { return null; }, async set() {}, async delete() {} },
    toastSink: [],
  } as unknown as EngineContext;
}

// ---------------------------------------------------------------------------
// ① 纯函数：buildFeedRequest 把 type 透出（并保留 data: 原样、不绝对化）
// ---------------------------------------------------------------------------

test('#408(a) buildFeedRequest：`data:;base64,…` 分类模板 ⇒ url 保留 data: 原样 + type 透出', async () => {
  const rule = compileRssSource({ sourceUrl: 'https://18av.test', sourceName: '18AV', sortUrl: SORT_TPL } as RssSourceRaw);
  const env = makeRssEnv(makeCtx({ async request(): Promise<HttpResponse> { throw new Error('零网络'); } }), rule, 'https://18av.test');
  const req = await buildFeedRequest(SORT_TPL, rule, env, { page: 1, stripSortPrefix: true });
  assert.equal(req.url, `data:;base64,${b64('/zh/chinese_list/all/1.html')}`, `data: URL 必须原样且已求值 {{}}：${req.url}`);
  assert.equal(req.type, '18av', 'URL 选项 type 必须随请求透出（响应体 hex 开关）');
});

test('#408(a) buildFeedRequest 对偶：无 type 的普通 URL ⇒ 不产生 type（绝不 hex 普通源）', async () => {
  const rule = compileRssSource({ sourceUrl: 'https://x.test', sourceName: 'X', sortUrl: '最新::/list?p={{page}}' } as RssSourceRaw);
  const env = makeRssEnv(makeCtx({ async request(): Promise<HttpResponse> { throw new Error('零网络'); } }), rule, 'https://x.test');
  const req = await buildFeedRequest('最新::/list?p={{page}}', rule, env, { page: 1, stripSortPrefix: true });
  assert.equal(req.url, 'https://x.test/list?p=1');
  assert.equal(req.type, undefined);
});

// ---------------------------------------------------------------------------
// ② 引擎集成：data: URL 取 arraybuffer ⇒ 规则收到「字节 hex」并可 hexDecodeToString 还原
// ---------------------------------------------------------------------------

test('#408(a) category：data: 分类 URL ⇒ 请求取 arraybuffer，规则 result = 路径字节的 hex', async () => {
  const PATH = '/zh/chinese_list/all/1.html';
  const rule = compileRssSource({
    sourceUrl: 'https://18av.test',
    sourceName: '18AV',
    sortUrl: SORT_TPL,
    // 规则自证：① 收到的 result 是纯 hex；② hexDecodeToString 能还原出路径。
    // ⚠️ 输出用「HTML 字符串数组」而非 jsoup Elements —— L1 直连时 setContent(活元素对象)
    //    选不中（worker 路径会把元素序列化成 HTML 串，本测试不走 worker）⇒ 用串数组最贴近真实。
    ruleArticles:
      '<js>let isHex=/^[0-9a-f]+$/.test(result);' +
      'let p=java.hexDecodeToString(result);' +
      'result=[\'<div class="post"><a>\'+(isHex?\'HEX-OK\':\'HEX-BAD\')+\'|\'+p+\'</a></div>\']</js>',
    ruleTitle: 'a@text',
  } as RssSourceRaw);

  const reqs: Array<{ url: string; responseType?: string }> = [];
  const http: HttpClient = {
    async request(url: string, o?: { responseType?: string }): Promise<HttpResponse> {
      reqs.push({ url, ...(o?.responseType ? { responseType: o.responseType } : {}) });
      const buf = Buffer.from(PATH, 'utf-8');
      return {
        status: 200,
        headers: {},
        body: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
        url,
      };
    },
  };

  const cat = await new RssEngine().category(rule, { action: 'category', page: 1 }, makeCtx(http));

  assert.equal(reqs[0]?.url, `data:;base64,${b64(PATH)}`, `请求地址应是 data: URL：${reqs[0]?.url}`);
  assert.equal(reqs[0]?.responseType, 'arraybuffer', 'type 分支必须取二进制（否则拿到的是已解码文本）');
  assert.equal(cat.items.length, 1);
  assert.equal(
    cat.items[0]!.title,
    `HEX-OK|${PATH}`,
    `规则应从 hex 还原路径；实际 title=${JSON.stringify(cat.items[0]!.title)}`,
  );
});

test('#408(a) 对偶：无 type 的普通列表 ⇒ 不取 arraybuffer、body 原样文本', async () => {
  const XML = '<?xml version="1.0"?><rss><channel><item><title>甲</title><link>https://x.test/1</link></item></channel></rss>';
  const rule = compileRssSource({ sourceUrl: 'https://x.test', sourceName: 'X', sortUrl: '最新::/list' } as RssSourceRaw);
  const reqs: Array<{ url: string; responseType?: string }> = [];
  const http: HttpClient = {
    async request(url: string, o?: { responseType?: string }): Promise<HttpResponse> {
      reqs.push({ url, ...(o?.responseType ? { responseType: o.responseType } : {}) });
      return { status: 200, headers: {}, body: XML, url };
    },
  };
  const cat = await new RssEngine().category(rule, { action: 'category', page: 1 }, makeCtx(http));
  assert.equal(reqs[0]?.responseType, undefined, '无 type 不得请求二进制');
  assert.equal(cat.items[0]!.title, '甲');
});
