/**
 * `#780` 回归锁：`/api/proxy` 的**上游响应头预算**分档。
 *
 * 用户 2026-11-05 第二轮拍板「融合方案」：
 *   · **图片类一律 10s** —— `cover=1`、正文图（`Accept: image/*`）、`retry=1`、
 *     `cover=1&retry=1` 全部 10s；
 *   · 普通非图片代理 ⇒ **20s**（既有行为）；`range` ⇒ **60s**（既有行为）；
 *   · **响应体预算不受影响**（`imageDeadline` 仍是 10s，见下面的接线锁）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROXY_HEADER_TIMEOUT_MS, isImageProxyRequest, proxyHeaderTimeoutMs } from '../proxy-timeout';

test('#780 ①：cover=1 ⇒ 10s', () => {
  assert.equal(proxyHeaderTimeoutMs({ cover: '1' }, false), 10_000);
});

test('#780 ②：正文图（无 cover，Accept: image/*）⇒ 10s', () => {
  assert.equal(proxyHeaderTimeoutMs({ image: true }, false), 10_000);
  assert.equal(isImageProxyRequest({}, 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'), true);
});

test('#780 ③：retry=1（正文图重试）⇒ 10s', () => {
  assert.equal(proxyHeaderTimeoutMs({ retry: '1' }, false), 10_000);
});

test('#780 ④：cover=1&retry=1 ⇒ 10s', () => {
  assert.equal(proxyHeaderTimeoutMs({ cover: '1', retry: '1' }, false), 10_000);
});

test('#780 ⑤：普通非图片代理 ⇒ 20s（既有行为不变）', () => {
  assert.equal(proxyHeaderTimeoutMs({}, false), 20_000);
  assert.equal(proxyHeaderTimeoutMs({ cover: '', retry: '' }, false), 20_000);
  assert.equal(proxyHeaderTimeoutMs({ cover: '0', retry: '0' }, false), 20_000);
  assert.equal(proxyHeaderTimeoutMs({ retry: '2' }, false), 20_000);
  // 非图片的 Accept（XHR/fetch、音频中转）不命中图片档
  assert.equal(isImageProxyRequest({}, '*/*'), false);
  assert.equal(isImageProxyRequest({}, 'application/json'), false);
  assert.equal(isImageProxyRequest({ cover: '1' }, '*/*'), true);
  assert.equal(isImageProxyRequest({ retry: '1' }, '*/*'), true);
});

test('#780 ⑥：range ⇒ 60s（区段/媒体优先于图片档）', () => {
  assert.equal(proxyHeaderTimeoutMs({}, true), 60_000);
  assert.equal(proxyHeaderTimeoutMs({ cover: '1' }, true), 60_000);
  assert.equal(proxyHeaderTimeoutMs({ retry: '1' }, true), 60_000);
  assert.equal(proxyHeaderTimeoutMs({ image: true }, true), 60_000);
});

test('#780 ⑦：三档常量与函数返回值一致', () => {
  assert.equal(PROXY_HEADER_TIMEOUT_MS.image, 10_000);
  assert.equal(PROXY_HEADER_TIMEOUT_MS.normal, 20_000);
  assert.equal(PROXY_HEADER_TIMEOUT_MS.range, 60_000);
});

test('#780 ⑧ 接线锁：主请求与桌面 UA 补发都用同一档；体预算仍 10s 不动', () => {
  const src = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
  assert.match(src, /const headerTimeoutMs = proxyHeaderTimeoutMs\(\{ \.\.\.req\.query, image: imageRequest \}, !!range\)/);
  assert.match(src, /const imageRequest = isImageProxyRequest\(req\.query, acceptHeader\)/);
  const uses = [...src.matchAll(/timeout: headerTimeoutMs,/g)].length;
  assert.equal(uses, 2, `主请求与桌面 UA 补发都应使用 headerTimeoutMs，实际出现 ${uses} 次`);
  // 封面请求必须豁免熔断计数、熔断中照常发出；两处 request 都要带
  const exempts = [...src.matchAll(/countBreaker: false, bypassBreaker: true/g)].length;
  assert.equal(exempts, 2, `封面的主请求与补发都应豁免熔断，实际出现 ${exempts} 次`);
  // 响应体预算（#747）必须原样保留：cover/图片 10s，文本/清单不设限
  const deadline = src.split(/\r?\n/).find((l) => l.includes('const imageDeadline'));
  assert.ok(deadline, '未找到 imageDeadline（响应体预算）');
  assert.ok(deadline.includes('10_000 : 0'), `响应体预算不得随响应头预算一起改动：${deadline}`);
  assert.ok(!deadline.includes('headerTimeoutMs'), '响应头预算不得混进响应体预算');
});
