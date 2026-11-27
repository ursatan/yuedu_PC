/**
 * 登录头同域门槛回归锁（对齐 Legado `AnalyzeUrl.isLoginHeaderSite`）。
 *
 * 上游依据：
 *  · `AnalyzeUrl.kt:139-141`：`getHeaderMap(hasLoginHeader && isLoginHeaderSite(mUrl))`
 *  · `AnalyzeUrl.kt:154-170`：按 `NetworkUtils.getSubDomainOrNull`（eTLD+1，公共后缀表）比源域与目标域，
 *    **无法判定时返回 `true`**（保持旧行为，不误拦）。
 *
 * 为什么必须锁：封面/图床 CDN 多在第三方域，带 `Cookie`/`Authorization` 会被风控拦，
 * 且等于把登录态外泄；反过来「同站子域」也不该误拦（登录后首页/详情页都在同一站点）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { siteDomainOf, isLoginHeaderSite } from '../net/url-resolve';

test('siteDomainOf：取 eTLD+1（子域归并到同一站点）', () => {
  assert.equal(siteDomainOf('https://www.example.com/a/b'), 'example.com');
  assert.equal(siteDomainOf('https://api.example.com:8443/x?y=1'), 'example.com');
  assert.equal(siteDomainOf('http://EXAMPLE.com./path'), 'example.com', '大小写与结尾点都要归一');
});

test('siteDomainOf：多级后缀按三段取（com.cn / co.uk）', () => {
  assert.equal(siteDomainOf('https://a.example.com.cn/x'), 'example.com.cn');
  assert.equal(siteDomainOf('https://a.example.co.uk/x'), 'example.co.uk');
  assert.equal(siteDomainOf('https://shop.example.co.jp/'), 'example.co.jp');
});

test('siteDomainOf：IP 整串即站点标识（去掉端口）', () => {
  assert.equal(siteDomainOf('http://127.0.0.1:8080/x'), '127.0.0.1');
  assert.equal(siteDomainOf('http://[::1]:8080/x'), '[::1]');
});

test('siteDomainOf：非 http(s)、相对地址、空值 ⇒ null（调用方据此保持原行为）', () => {
  assert.equal(siteDomainOf('data:image/png;base64,AAAA'), null);
  assert.equal(siteDomainOf('/book/1/'), null);
  assert.equal(siteDomainOf(''), null);
  assert.equal(siteDomainOf(undefined), null);
});

test('siteDomainOf：源把 data URL 包成 `https://host@js:…` 时只取 host 部分', () => {
  // 只断言 `@js:` 之后的内容不参与解析（host 正常归一为 eTLD+1）
  assert.equal(siteDomainOf("https://img.example.com/cover.jpg@js:'data:image/png;base64,AA'"), 'example.com');
});

test('isLoginHeaderSite：同站（含子域/端口差异）⇒ true', () => {
  assert.equal(isLoginHeaderSite('https://www.example.com/book/1', 'https://example.com'), true);
  assert.equal(isLoginHeaderSite('https://api.example.com:8443/x', 'http://example.com/'), true);
  assert.equal(isLoginHeaderSite('https://a.example.com.cn/x', 'https://b.example.com.cn/'), true);
});

test('isLoginHeaderSite：跨站 ⇒ false（CDN/图床不得带登录态）', () => {
  assert.equal(isLoginHeaderSite('https://cdn.other.com/x.jpg', 'https://example.com'), false);
  assert.equal(isLoginHeaderSite('https://example.com.cn/x', 'https://other.com.cn'), false);
  assert.equal(isLoginHeaderSite('https://127.0.0.1/x', 'https://127.0.0.2'), false);
});

test('isLoginHeaderSite：任一侧无法判定 ⇒ true（上游 `?: return true` 的保守语义）', () => {
  // 源 URL 缺失 / 相对地址：保持「仍附加登录头」的旧行为
  assert.equal(isLoginHeaderSite('https://example.com/x', ''), true);
  assert.equal(isLoginHeaderSite('https://example.com/x', undefined), true);
  // 目标 URL 不是 http(s)（data URL、相对地址）：同样不拦
  assert.equal(isLoginHeaderSite('data:image/png;base64,AA', 'https://example.com'), true);
  assert.equal(isLoginHeaderSite('/book/1/', 'https://example.com'), true);
});
