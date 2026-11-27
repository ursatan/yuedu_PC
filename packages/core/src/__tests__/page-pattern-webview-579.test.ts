/**
 * `#579`/`#580` 两个「工坊能过、真跑不能」的引擎入口判据：
 *
 *  · `#579` 发现页 `exploreUrl` 的 JS bindings 必须带 `baseUrl`（Legado 必带项）；
 *  · `#579` URL 里的 `<1,2,3>` 页码模式必须在绝对化之前替换（否则 `<,index_1.html>`
 *    会被 `new URL()` 编码成 `%3C,index_1.html%3E` ⇒ 站点 404）；
 *  · `#580` `java.webView` 的静态兜底必须把裸 JSON 包成浏览器 JSON viewer 的 `<pre>` 形态。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { asWebViewDocument } from '../selector/js';
import { pickPagePattern } from '../net/url-resolve';

test('#579 `<a,b,c>` 页码模式：按页取项、越界取末项、单值原样保留', () => {
  assert.equal(pickPagePattern('/list/<,index_1.html>', 1).s, '/list/');
  assert.equal(pickPagePattern('/list/<,index_1.html>', 3).s, '/list/index_1.html');
  assert.equal(pickPagePattern('/p/<1,2,3>.html', 2).s, '/p/2.html');
  assert.equal(pickPagePattern('/p/<1,2,3>.html', 9).s, '/p/3.html');
  assert.equal(pickPagePattern('/p/<only>.html', 2).s, '/p/<only>.html', '单个值不是页码模式');
  assert.equal(pickPagePattern('/plain', 2).used, false);
});

test('#580 裸 JSON 按浏览器 JSON viewer 形态包成 <pre>（HTML / 空串原样）', () => {
  const json = '[{"id":1,"name":"a & b"}]';
  const wrapped = asWebViewDocument(json);
  assert.match(wrapped, /^<html><head><\/head><body><pre>/, '必须以 <pre> 包裹');
  assert.match(wrapped, />\[\{"id":1/, '源的 `>\\[\\{.*?}]<` 正则可命中');
  assert.ok(wrapped.includes('a &amp; b'), '必须转义 &');
  const html = '<html><body>hi</body></html>';
  assert.equal(asWebViewDocument(html), html, 'HTML 不得二次包装');
  assert.equal(asWebViewDocument(''), '', '空串原样');
  assert.equal(asWebViewDocument('{"a":1}<x>'), '{"a":1}<x>', '已带标签的混排不包装');
});
