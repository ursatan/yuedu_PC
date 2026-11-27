/**
 * 回归锁：**`#588` HentaiCosplay「目录 0；未取到目录（源没有产出章节）」**。
 *
 * 病征链（用户 2026-10-23 实测，无 tocError 的最难分形状）：
 * ① 该源搜索规则把 bookUrl 造成 `data:;base64,<href>,{"type":""}`（`a@href` 取出链接后
 *    `@js:` 包成 data URL）⇒ detail 抓到的是 href 的 hex（`#578` 已对齐上游 `type != null`）；
 * ② `ruleBookInfo.init` 判 `baseUrl.slice(0,4)==="http"` —— data URL 不成立 ⇒ 走 else
 *    **返回空** ⇒ 书名/封面/tocUrl 全空；
 * ③ 目录脚本 `[{name: book.name, url: …}]` 的章名来自 `book.name` —— 前端
 *    `runAction(src,'detail',{id})` **从不传 `req.title`**，引擎原来只认它 ⇒ `book.name`
 *    恒 undefined ⇒ 章名空 ⇒ 被 `if (!ct) continue` 静默滤掉 ⇒ **0 章且不报错**。
 *
 * 上游语义：Legado 的 `Book.name` 来自**搜索结果**，详情 init 只在非空时覆盖
 * （`BookInfo.kt:68-73`）。修法：`bookData.name` 回落 **payload.name/title**
 * （搜索/发现组装的 payload 一直带着 name；书架流的 payload 也是搜索沉淀的）。
 *
 * 防空转对偶（用例②）：payload/req 都不带书名时必须**仍然 0 章** —— 证明用例①的
 * 「1 章」是回落逻辑挣来的，不是测试本身放水。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpRequestOptions, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://hc.test';
const HREF = '/image/test-book-1/';
/** 搜索规则原样构造的 bookUrl：data URL 包 href + 显式空 type */
const BOOK_URL_DATA = `data:;base64,${Buffer.from(HREF, 'utf-8').toString('base64')},{"type":""}`;
const CHAPTER_URL = `${BASE}/story${HREF.slice(6)}`;

function makeSrc() {
  const out = compileBookSource({
    bookSourceUrl: `${BASE}/`,
    bookSourceName: 'hc-588 回归源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
    // init：baseUrl 是 data URL ⇒ 不走 http 分支 ⇒ 返回空（HentaiCosplay 的 else 分支）
    ruleBookInfo: {
      init: '@js: baseUrl.slice(0,4)==="http" ? {name: result} : ""',
      name: 'name',
      tocUrl: 'tocUrl',
    },
    // 目录：章名来自 book.name（= 搜索结果的书名），URL 拼在 href 的 hex 解码值上
    ruleToc: {
      chapterList:
        '@js:[{name: book.name, url: source.getKey()+"story"+java.hexDecodeToString(result).slice(6)}]',
      chapterName: 'name',
      chapterUrl: 'url',
    },
    ruleContent: { content: '@js:result' },
  });
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);
  return out.rule!;
}

/** mock：data URL 按 Node fetch 语义解 base64（type 分支引擎会要 arraybuffer） */
function makeCtx() {
  const reqs: Array<{ url: string; responseType?: string }> = [];
  const ctx: EngineContext = {
    reqId: 'hc-588',
    sourceId: 'hc-588',
    signal: new AbortController().signal,
    http: {
      async request(url: string, o: HttpRequestOptions = {}): Promise<HttpResponse> {
        reqs.push({ url, ...(o.responseType ? { responseType: o.responseType } : {}) });
        const m = /^data:;base64,([^,]+)/.exec(url);
        if (m) {
          const bytes = Buffer.from(m[1] ?? '', 'base64');
          if (o.responseType === 'arraybuffer') {
            return {
              status: 200,
              headers: {},
              body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
              url,
            };
          }
          return { status: 200, headers: {}, body: bytes.toString('utf8'), url };
        }
        return { status: 200, headers: {}, body: '<html><body>stub</body></html>', url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, reqs };
}

test('#588 章名回落 payload.name：data URL bookUrl + init 返空 ⇒ 目录仍出 1 章', async () => {
  const { ctx, reqs } = makeCtx();
  const out = await new LegadoEngine().detail(
    makeSrc(),
    { action: 'detail', id: JSON.stringify({ bookUrl: BOOK_URL_DATA, name: '测试书名' }) },
    ctx,
  );
  /**
   * `data:;base64,<href>,{"type":""}` ⇒ 命中「字节路径 + data: 短路」（上游 `getByteArrayIfDataUri`）
   * ⇒ **一个网络请求都不发**，真页面从未被抓 —— 这本源的设计就是这样。
   * （`#639` 之前这里断言的是「发了 1 个 data: 请求 + responseType=arraybuffer」，
   *  那是把 mock 的 base64 解码当成了传输层行为；现在短路发生在传输层之前，
   *  不变量升级为更强的「零网络」。hex 还原由下面的 chapterUrl 断言继续锁。）
   */
  assert.equal(reqs.length, 0, `data: URI 不应发出任何网络请求，实际 ${reqs.length}`);
  assert.equal(out.chapters?.length, 1, `应出 1 章，实际 ${out.chapters?.length}`);
  assert.equal(out.chapters?.[0]?.title, '测试书名', '章名必须回落 payload.name（搜索书名）');
  assert.equal(
    (out.chapters?.[0]?.payload as { chapterUrl?: string } | undefined)?.chapterUrl,
    CHAPTER_URL,
    '章地址必须是 getKey()+story+hexDecode(href).slice(6)',
  );
});

test('#588 防空转对偶：payload/req 都不带书名 ⇒ 章名空被滤掉（0 章，修复前的病态）', async () => {
  const { ctx } = makeCtx();
  const out = await new LegadoEngine().detail(
    makeSrc(),
    { action: 'detail', id: JSON.stringify({ bookUrl: BOOK_URL_DATA }) },
    ctx,
  );
  // 没有书名来源时章名确实为空 —— 证明上一个用例的「1 章」是回落逻辑挣来的
  assert.equal(out.chapters?.length ?? 0, 0, '无书名来源时必须 0 章（旧病态，防测试放水）');
});
