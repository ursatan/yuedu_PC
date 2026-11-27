/**
 * `#378` 回归锁：`/api/proxy` 的**上游状态码映射**与**限流/换 UA 判定**。
 *
 * 背景（缺陷类别）：旧实现「`res.status >= 400` 一律 502」把**上游明确的拒绝**
 * 伪装成**中介故障** ⇒ 读状态码的调用方判断错误。真实案例：momoa.cc.cd 的
 * 「测试版」卡片直连 GitHub API（未认证限流 60/h ⇒ 403），被包成 502 ⇒
 * 站点脚本显示「获取失败 HTTP 502」。见 `proxy-status.ts` 头注。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UA_RETRY_STATUS, isRateLimited, proxyStatusAction } from '../proxy-status';

test('proxyStatusAction：4xx 透传（不再伪装成 502）', () => {
  for (const code of [400, 401, 403, 404, 410, 429, 451]) {
    assert.equal(proxyStatusAction(code), 'passthrough-4xx', `${code} 应透传`);
  }
});

test('proxyStatusAction：5xx 仍回 502（真中介故障）', () => {
  for (const code of [500, 501, 502, 503, 504, 599]) {
    assert.equal(proxyStatusAction(code), 'gateway-502', `${code} 应 502`);
  }
});

test('proxyStatusAction：< 400 正常透传', () => {
  for (const code of [200, 201, 206, 301, 302, 304]) {
    assert.equal(proxyStatusAction(code), 'pass', `${code} 应 pass`);
  }
});

test('isRateLimited：429 恒为限流（RFC 6585 标准码）', () => {
  assert.equal(isRateLimited(429, {}), true);
});

test('isRateLimited：403 + x-ratelimit-remaining=0 ⇒ 限流（GitHub 形态）', () => {
  assert.equal(isRateLimited(403, { 'x-ratelimit-remaining': '0' }), true);
  // 数组形态也要认（上游可能给多值）
  assert.equal(isRateLimited(403, { 'x-ratelimit-remaining': ['0'] }), true);
});

test('isRateLimited：403 但配额未耗尽 ⇒ **不是**限流（是防盗链/WAF，可换 Referer/UA）', () => {
  assert.equal(isRateLimited(403, { 'x-ratelimit-remaining': '7' }), false);
  assert.equal(isRateLimited(403, {}), false); // 无该头 ⇒ 按防盗链处理
});

test('isRateLimited：400/404/500 不因限流头而变（判定只看 429 或 remaining=0）', () => {
  assert.equal(isRateLimited(400, { 'x-ratelimit-remaining': '0' }), true); // 头为准
  assert.equal(isRateLimited(404, {}), false);
  assert.equal(isRateLimited(500, {}), false);
});

test('UA_RETRY_STATUS：400/403/429 值得换 UA 补发；404 等不属于', () => {
  assert.equal(UA_RETRY_STATUS.has(400), true);
  assert.equal(UA_RETRY_STATUS.has(403), true);
  assert.equal(UA_RETRY_STATUS.has(429), true);
  for (const code of [200, 401, 404, 410, 500, 502]) {
    assert.equal(UA_RETRY_STATUS.has(code), false, `${code} 不应触发换 UA`);
  }
});
