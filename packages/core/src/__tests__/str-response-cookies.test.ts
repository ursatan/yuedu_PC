/**
 * **`#639`（2026-10-26）** `StrResponse.cookies()` 与 `cookie.mapToCookie(...)`。
 *
 * ## 真站取证（书旗听书本地源（同人），用户实测第 4 条）
 * jsLib 的 `Token()` 用**登录 Cookie 换 token**：
 * ```js
 * var token = java.get(origin, {}).cookies().toString().match(/shuqi_token=([^,]*)/)[1];
 * ```
 * 本仓响应包装此前没有 `cookies()` ⇒ `TypeError: java.get(...).cookies is not a function`
 * ⇒ `GetUrl` 抛错 ⇒ `bodyJs` 求值失败 ⇒ 详情/目录/正文全空（发现页却正常）。
 *
 * 而 `https://t.shuqi.com` 实际回**三条** Set-Cookie
 * （`csrfToken` / `shuqi_token` / `shuqi_user_id`），必须都拿到 ——
 * 传输层把它们单独存成数组（合并成一条会被 `Expires` 里的逗号破坏）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeStrResponse } from '../selector/js';
import { createJsEvaluator, createVariableStore } from '../index';

type CookieItem = { name: string; value: string; toString: () => string };

test('cookies()：多条 Set-Cookie（\\n 分隔）逐条解析，toString = name=value', () => {
  const sc = 'csrfToken=abc; path=/\nshuqi_token=eyJhbG.xxx; path=/; domain=.shuqi.com\nshuqi_user_id=8000000; path=/';
  const r = makeStrResponse('https://t.shuqi.com', '<html>', 200, { 'set-cookie': sc });
  const list = (r['cookies'] as () => CookieItem[])();
  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map((c) => c.name),
    ['csrfToken', 'shuqi_token', 'shuqi_user_id'],
  );
  // 源里的写法：.toString().match(/shuqi_token=([^,]*)/)[1]
  const m = /shuqi_token=([^,]*)/.exec(list.toString());
  assert.equal(m?.[1], 'eyJhbG.xxx');
});

test('cookies()：没有 Set-Cookie 时返回空数组（不抛）', () => {
  const r = makeStrResponse('https://x.test', 'body', 200, { 'content-type': 'text/html' });
  assert.equal((r['cookies'] as () => CookieItem[])().length, 0);
});

test('cookie.mapToCookie 支持 Cookie 列表（爱丽丝书屋 loginUrl 的写法）', () => {
  const variables = createVariableStore();
  const evalJs = createJsEvaluator({ variables });
  const out = evalJs(
    `var items = [{ name: 'lf_user_auth', value: 'xyz' }, { name: 'b', value: '2' }];
     cookie.mapToCookie(items)`,
    {},
  );
  assert.equal(String(out), 'lf_user_auth=xyz; b=2');
});

test('cookie.mapToCookie 原有 Map / 对象形态不受影响', () => {
  const variables = createVariableStore();
  const evalJs = createJsEvaluator({ variables });
  assert.equal(String(evalJs(`cookie.mapToCookie({ a: '1', b: '2' })`, {})), 'a=1; b=2');
});
