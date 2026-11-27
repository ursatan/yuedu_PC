/**
 * `#606`：交给 **curl** 之前的 URL 规范化 —— 非 ASCII 必须 percent-encode。
 *
 * ## 为什么要锁
 * 上游 Legado 用 okHttp（`Request.url(String)` → `HttpUrl.get()`），非 ASCII 自动按 UTF-8
 * percent-encode；本仓有两条路走 curl（`curlSyncFetch` 兜底、`engine-legado` 的 jsLib 下载），
 * curl **不编码**。实测（2026-10-24）同一条中文 URL：
 *   · 原样给 curl  ⇒ `http_code=000`，0 字节，等满超时；
 *   · `encodeURI` 后 ⇒ `200`，42618 字节。
 *
 * 症状长这样（G站漫画/MYCOMIC/包子漫画等 qyyuapi 系）：jsLib 映射表里路径带中文
 * （`https://qyyuapi.com/sy/js/G站漫画/jsLib.js`）⇒ 两个库都拉空 ⇒ 源里的
 * `Get/Map/Reload` 全未定义 ⇒ `Reload is not defined`（**看起来**像源规则写错）。
 *
 * 修后同源 search 从 `RULE_PARSE` 变成 30 条（G社漫画/包子漫画实测）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeUrlForCurl } from '../net/url-resolve';

test('中文路径 → UTF-8 percent-encode（qyyuapi 系 jsLib 的真实形态）', () => {
  assert.equal(
    encodeUrlForCurl('https://qyyuapi.com/sy/js/G站漫画/jsLib.js'),
    'https://qyyuapi.com/sy/js/G%E7%AB%99%E6%BC%AB%E7%94%BB/jsLib.js',
  );
  assert.equal(
    encodeUrlForCurl('https://qyyuapi.com/dy/js/剧迷/loginUrl.js'),
    'https://qyyuapi.com/dy/js/%E5%89%A7%E8%BF%B7/loginUrl.js',
  );
});

test('已编码的 %XX 不二次编码（同一 URL 过两遍结果不变）', () => {
  const once = encodeUrlForCurl('https://qyyuapi.com/sy/js/G站漫画/jsLib.js');
  assert.equal(encodeUrlForCurl(once), once);
  // 全编码形态原样
  const encoded = 'https://x.test/a%20b/%E4%B8%AD.js?q=%E4%B8%AD';
  assert.equal(encodeUrlForCurl(encoded), encoded);
});

test('查询串里的中文同样编码，结构字符保留', () => {
  assert.equal(
    encodeUrlForCurl('https://x.test/s?q=我的&page=1#段'),
    'https://x.test/s?q=%E6%88%91%E7%9A%84&page=1#%E6%AE%B5',
  );
  // `? & = / : @` 这些结构字符不能被编码，否则请求结构就毁了
  for (const ch of ['?', '&', '=', '/', ':', '@']) {
    assert.ok(encodeUrlForCurl(`https://x.test/a${ch}b`).includes(ch), `结构字符 ${ch} 必须保留`);
  }
});

test('纯 ASCII URL 保持原样；空串原样返回', () => {
  const plain = 'https://qyyuapi.com/js/common.js';
  assert.equal(encodeUrlForCurl(plain), plain);
  assert.equal(encodeUrlForCurl(''), '');
});

test('孤立代理对（encodeURI 会抛 URIError）不炸，原样返回让失败可见', () => {
  const bad = 'https://x.test/\uD800.js';
  assert.equal(encodeUrlForCurl(bad), bad);
});
