/**
 * 回归锁：**POST 表单体的默认 Content-Type** 与 **`java.ajaxAll`**（两者都曾造成「L1 能跑、worker 跑不了」）。
 *
 * ① POST 表单体默认头
 *    Legado POST 非 JSON/XML 体走 OkHttp `FormBody` → 自带 `application/x-www-form-urlencoded`。
 *    我们此前只在引擎的 rule-URL 路径补过这个头，**java.ajax/worker 路径没有**：
 *      · L1 走 curl，而 curl 对 `--data-binary` 自带表单头 → 侥幸正常；
 *      · worker 走 undici `fetch`，字符串体默认 `text/plain` → 站点把 body 当非表单。
 *    实测（绿柠小说 exploreUrl）：worker 路径站点回 `{"status":0,"message":"二级聚合id缺失"}`
 *    （响应无 data → 动态子分类静默为空），补头后回 `status:1` + data 数组。
 *    现在默认头放在**共享源码** `net/url-prep.ts` 的 `__yueduOptionRequest`（L1/worker 同一份）。
 *
 * ② `java.ajaxAll(urls)`（Legado `JsExtensions.kt:154-168`）
 *    返回**同序**的 `StrResponse` 数组。此前**只在 worker 里有、L1 缺失** →
 *    L1 路径下落到「未实现的 java.* 返回空串」兜底 → 脚本 `ah[0]` 恒 undefined → 依赖它的分类/列表静默为空。
 *    返回形态用 `String` 包装（`new String(body)` + `.body()`）：`JSON.parse(res)` 与 `res.body()` 两种写法都能用。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';
import type { SyncHttpRequest, SyncHttpResponse } from '../selector/js';

/** 记录每次同步请求的 method / url / body / headers，并按 url 返回不同 body */
function makeSync(spy: SyncHttpRequest[], bodyFor: (url: string) => string = () => '{"data":[{"id":"7","title":"子分类"}]}') {
  return (req: SyncHttpRequest): SyncHttpResponse => {
    spy.push(req);
    return { status: 200, headers: { 'content-type': 'application/json' }, setCookie: [], body: bodyFor(req.url) };
  };
}

test('POST 表单体（java.ajax）默认带 application/x-www-form-urlencoded', () => {
  const spy: SyncHttpRequest[] = [];
  const ev = createJsEvaluator({ variables: createVariableStore(), syncFetch: makeSync(spy) });
  ev('java.ajax("https://x.test/a.do,{\\"method\\":\\"POST\\",\\"body\\":\\"id=12&page=1\\"}")', {});
  const ct = Object.entries(spy[0]?.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type');
  assert.ok(ct, `必须补上 Content-Type（否则 worker/fetch 会发 text/plain）：${JSON.stringify(spy[0]?.headers)}`);
  assert.equal(ct?.[1], 'application/x-www-form-urlencoded', `表单体：${ct?.[1]}`);
});

test('POST JSON 体默认带 application/json（对齐 Legado postJson）', () => {
  const spy: SyncHttpRequest[] = [];
  const ev = createJsEvaluator({ variables: createVariableStore(), syncFetch: makeSync(spy) });
  ev('java.ajax("https://x.test/a.do,{\\"method\\":\\"POST\\",\\"body\\":\\"{\\\\\\"a\\\\\\":1}\\"}")', {});
  const ct = Object.entries(spy[0]?.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type');
  assert.equal(ct?.[1], 'application/json', `JSON 体：${ct?.[1]}`);
});

test('源/选项显式给的 Content-Type 不得被覆盖', () => {
  const spy: SyncHttpRequest[] = [];
  const ev = createJsEvaluator({ variables: createVariableStore(), syncFetch: makeSync(spy) });
  ev('java.ajax("https://x.test/a.do,{\\"method\\":\\"POST\\",\\"body\\":\\"a=1\\",\\"headers\\":{\\"Content-Type\\":\\"application/json\\"}}")', {});
  const ct = Object.entries(spy[0]?.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type');
  assert.equal(ct?.[1], 'application/json', '显式头优先');
});

test('GET 不带 body 时不补 Content-Type（不得给 GET 加表单头）', () => {
  const spy: SyncHttpRequest[] = [];
  const ev = createJsEvaluator({ variables: createVariableStore(), syncFetch: makeSync(spy) });
  ev('java.ajax("https://x.test/a.do")', {});
  const ct = Object.entries(spy[0]?.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type');
  assert.equal(ct, undefined, `GET 不该有 Content-Type：${JSON.stringify(spy[0]?.headers)}`);
});

test('java.ajaxAll：返回同序数组，且 res.body() 与 JSON.parse(res) 两种写法都可用', () => {
  const spy: SyncHttpRequest[] = [];
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    syncFetch: makeSync(spy, (url) => `{"data":[{"id":"${url.slice(-1)}"}]}`),
  });
  const out = String(
    ev(
      [
        'var rs = java.ajaxAll(["https://x.test/1", "https://x.test/2", "https://x.test/3"]);',
        'JSON.stringify({ n: rs.length, order: rs.map(function(r){ return JSON.parse(r).data[0].id; }), viaBody: JSON.parse(rs[0].body()).data[0].id });',
      ].join('\n'),
      {},
    ),
  );
  assert.deepEqual(JSON.parse(out), { n: 3, order: ['1', '2', '3'], viaBody: '1' }, out);
  assert.equal(spy.length, 3, '三个 URL 都要发出去');
});

test('java.ajaxAll：非数组入参按空数组处理（不抛错）', () => {
  const spy: SyncHttpRequest[] = [];
  const ev = createJsEvaluator({ variables: createVariableStore(), syncFetch: makeSync(spy) });
  assert.equal(String(ev('java.ajaxAll("https://x.test/1").length', {})), '0');
  assert.equal(spy.length, 0);
});
