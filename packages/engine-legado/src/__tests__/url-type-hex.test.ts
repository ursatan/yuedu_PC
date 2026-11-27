/**
 * 回归锁：**URL 选项 `type` → 响应体是「字节的 hex 串」**（Legado `AnalyzeUrl.kt:443-445`）。
 *
 * ```kotlin
 * if (type != null) {
 *     return StrResponse(url, HexUtil.encodeHexStr(getByteArrayAwait()))
 * }
 * ```
 * 该分支在 WebView / executeStrRequest **之前**返回：有 `type` 就永不渲染、永不按 charset 解码。
 *
 * 典型用法（七猫官方正文，实测链路）：
 *   目录规则把章节页造成 `data:;base64,<base64(cid + "/" + content_md5)>,{"type":"qm"}`
 *   → 正文规则 `java.hexDecodeToString(result)` 还原成 `<cid>/<content_md5>` 去取密文。
 *
 * 不实现这条时的两种失败形态：
 *   · 旧实现（Node `Buffer.from(s,'hex')` 静默截断）→ 解出 3 个字节当 chapterId → 站点「参数错误」
 *     → 最终报 `Cannot read properties of undefined (reading 'data')`（整链没有一个环节报错）；
 *   · 严格 hex 后 → 直接抛 `Illegal hexadecimal character "/"`（把静默错值变成显式错因）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpRequestOptions, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://qm.test';
/** data URI 里承载的内容：`<chapterId>/<content_md5>`（七猫真实形态） */
const CID_PAYLOAD = '630355/90f43448748605081e66e4b790341c19';

function makeSrc(over: Record<string, unknown> = {}) {
  const out = compileBookSource({
    bookSourceUrl: `${BASE}/`,
    bookSourceName: 'type-hex 回归源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'bookName' },
    ruleContent: { content: '@js: java.hexDecodeToString(result)' },
    ...over,
  });
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);
  return out.rule!;
}

function makeCtx(respond: (n: number) => HttpResponse | Error) {
  const reqs: Array<{ url: string; responseType?: string }> = [];
  const ctx: EngineContext = {
    reqId: 'type-hex',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string, o?: HttpRequestOptions): Promise<HttpResponse> {
        reqs.push({ url, ...(o?.responseType ? { responseType: o.responseType } : {}) });
        const r = respond(reqs.length);
        if (r instanceof Error) throw r;
        return r;
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, reqs };
}

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

test('type 选项：响应体按「字节 hex」给出，规则 hexDecodeToString 还原原文', async () => {
  const rule = makeSrc();
  const raw = Buffer.from(CID_PAYLOAD, 'utf-8');
  const { ctx, reqs } = makeCtx(() => ({
    status: 200,
    headers: {},
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    url: `${BASE}/c`,
  }));
  const url = `data:;base64,${b64(CID_PAYLOAD)},{"type":"qm"}`;
  const out = await new LegadoEngine().content(
    rule,
    { action: 'content', id: JSON.stringify({ chapterUrl: url, title: '第1章' }) },
    ctx,
  );
  assert.equal(reqs.length, 0, 'data: URI 命中字节路径就完全不发网络（上游 getByteArrayIfDataUri）');
  assert.equal(out.paragraphs[0], CID_PAYLOAD, `hex 还原失败：${JSON.stringify(out.paragraphs.slice(0, 2))}`);
});

test('`type:""`（显式空串）也按 hex 处理 —— 与上游 `type != null` 对齐', async () => {
  /**
   * `#578` HentaiCosplay 目录：tocUrl = `data:;base64,<url>,{"type":""}`，
   * 脚本 `java.hexDecodeToString(result).slice(6)`。旧判据把空串当「无 type」⇒ result 是
   * 解码后的 URL（以 `/` 开头）⇒ hex 解码首字符即抛 `Illegal hexadecimal character "/"`。
   */
  const rule = makeSrc({ ruleContent: { content: '@js: java.hexDecodeToString(result)' } });
  const raw = Buffer.from(CID_PAYLOAD, 'utf-8');
  const { ctx, reqs } = makeCtx(() => ({
    status: 200,
    headers: {},
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    url: `${BASE}/c`,
  }));
  const url = `data:;base64,${b64(CID_PAYLOAD)},{"type":""}`;
  const out = await new LegadoEngine().content(
    rule,
    { action: 'content', id: JSON.stringify({ chapterUrl: url, title: '第1章' }) },
    ctx,
  );
  assert.equal(reqs.length, 0, 'data: URI 命中字节路径就完全不发网络');
  assert.equal(out.paragraphs[0], CID_PAYLOAD);
});

test('普通 http URL + type：传输层必须取二进制（data: 短路不影响这条）', async () => {
  /**
   * `#639`：`data:` 短路只覆盖「data: + type」；**普通 URL + type 仍要 `responseType:'arraybuffer'`**
   * ——否则拿到的是按 charset 解码后的文本，`java.hexDecodeToString` 解的是错的东西。
   * 这条是原来那句 `reqs[0].responseType === 'arraybuffer'` 断言的搬家：它锁的是**传输契约**，
   * 而上面两条锁的是「内存里的字节 → hex」，两件事分开测才不会互相掩盖。
   */
  const rule = makeSrc({ ruleContent: { content: '@js: java.hexDecodeToString(result)' } });
  const raw = Buffer.from(CID_PAYLOAD, 'utf-8');
  const { ctx, reqs } = makeCtx(() => ({
    status: 200,
    headers: {},
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    url: `${BASE}/c`,
  }));
  const out = await new LegadoEngine().content(
    rule,
    { action: 'content', id: JSON.stringify({ chapterUrl: `${BASE}/c,{"type":"qm"}`, title: '第1章' }) },
    ctx,
  );
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0]?.responseType, 'arraybuffer', 'type 分支必须取二进制（否则拿到的是已解码文本）');
  assert.equal(out.paragraphs[0], CID_PAYLOAD);
});

test('无 type 选项：按文本处理，绝不 hex（否则普通源正文会变成十六进制串）', async () => {
  const rule = makeSrc({ ruleContent: { content: '@js: result' } });
  const { ctx, reqs } = makeCtx(() => ({ status: 200, headers: {}, body: '第一章 正文', url: `${BASE}/c` }));
  const out = await new LegadoEngine().content(
    rule,
    { action: 'content', id: JSON.stringify({ chapterUrl: `${BASE}/c`, title: '第1章' }) },
    ctx,
  );
  assert.equal(reqs[0]?.responseType, undefined, '无 type 不得请求二进制');
  assert.equal(out.paragraphs[0], '第一章 正文');
});

test('严格 hex：非法字符抛错（杜绝 Node 静默截断造成的「静默错值」）', async () => {
  const rule = makeSrc({ ruleContent: { content: '@js: java.hexDecodeToString(result)' } });
  const { ctx } = makeCtx(() => ({ status: 200, headers: {}, body: CID_PAYLOAD, url: `${BASE}/c` }));
  const thrown = await new LegadoEngine()
    .content(rule, { action: 'content', id: JSON.stringify({ chapterUrl: `${BASE}/c` }) }, ctx)
    .then(() => undefined)
    .catch((e: unknown) => e as { detail?: { input?: string } });
  assert.ok(thrown, '含 "/" 的输入必须抛错（hutool decodeHex 同款语义）');
  assert.match(String(thrown.detail?.input ?? ''), /Illegal hexadecimal character/, `错误必须点名非法字符：${JSON.stringify(thrown.detail)}`);
});
