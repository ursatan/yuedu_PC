/**
 * `#731` 断点 1：**「401 + 阿里云 WAF」才触发验证路径；普通 401 JSON 不误判**。
 *
 * 判据唯一实现在 `detectWafHit`（`hub.ts`），这里锁三组：
 *  ① 401 + WAF 特征 ⇒ `hit`（且 via 能说清是阿里云）；
 *  ② 401 + 普通 JSON（登录失效 / 接口鉴权）⇒ `hit:false`；
 *  ③ 403 / 429 同类特征 ⇒ `hit`（与 401 同一条链）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectWafHit } from '../hub';

const WAF_PAGE = `<!DOCTYPE html><html><head><title>访问验证</title>
<script>var __wafcaptcha = {}; document.cookie='acw_sc__v2=...';</script></head>
<body>访问频率太高，请输入验证码</body></html>`;

test('#731 ①：401 + 阿里云 WAF ⇒ 判定命中（触发静默过闸 → 失败回落人工验证）', () => {
  const r = detectWafHit({ status: 401, body: WAF_PAGE });
  assert.equal(r.hit, true);
  assert.match(String(r.via), /阿里云 WAF/);
});

test('#731 ②：401 + 普通 JSON 不误判（登录失效/接口鉴权不是反爬）', () => {
  for (const body of [
    '{"code":401,"message":"登录已失效，请重新登录"}',
    '{"error":"unauthorized","ok":false}',
    '请先登录后再访问',
  ]) {
    const r = detectWafHit({ status: 401, body });
    assert.equal(r.hit, false, `普通 401 不该判成 WAF：${body}`);
  }
});

test('#731 ③：403 / 429 同类特征同样识别（不只 401）', () => {
  for (const status of [403, 429]) {
    const r = detectWafHit({ status, body: WAF_PAGE });
    assert.equal(r.hit, true, `status=${status} 带 WAF 特征必须命中`);
  }
});

test('#731 ④：最终 URL 落到验证页（/waf、/captcha、/challenge）时也判命中', () => {
  const r = detectWafHit({ status: 200, body: '<html><body>ok</body></html>', finalUrl: 'https://site.example/waf/verify?x=1' });
  assert.equal(r.hit, true);
  assert.equal(r.redirectPath, '/waf/verify');
});

test('#731 ⑤：空正文不命中（宁可继续走原响应，也不要凭空开验证窗）', () => {
  assert.equal(detectWafHit({ status: 401, body: '' }).hit, false);
});
