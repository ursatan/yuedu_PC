/**
 * 回归锁 #85：网络错误必须给出**可读原因**（不能只留一句 `fetch failed`）。
 *
 * 基线实测（557 源）：**42 个**源报 `NETWORK@request: fetch failed`，而这四个字把
 * 「域名失效 / 证书过期 / 连接被拒 / 连接超时」四种完全不同的情况混成一句
 * → 长期被当成「站点侧不可控」而不去分辨（也就不可能发现其中混着的引擎问题）。
 * 归因实测（`scripts/dbg-net.mjs --class fetchfailed`）：
 *   ENOTFOUND/ENOENT 域名失效 · CERT_HAS_EXPIRED 证书过期 ·
 *   ERR_TLS_CERT_ALTNAME_INVALID 证书域名不匹配 · ECONNREFUSED · ECONNRESET · UND_ERR_CONNECT_TIMEOUT
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeNetworkError } from '../net';

function failWith(code: string): Error {
  const e = new TypeError('fetch failed') as Error & { cause?: unknown };
  e.cause = Object.assign(new Error('inner'), { code });
  return e;
}

test('#85 常见网络错误逐条给出可读原因', () => {
  const cases: Array<[string, RegExp]> = [
    ['ENOTFOUND', /DNS 解析失败/],
    ['ENOENT', /DNS 解析失败/],
    ['CERT_HAS_EXPIRED', /证书已过期/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', /证书域名不匹配/],
    ['ECONNREFUSED', /连接被拒绝/],
    ['ECONNRESET', /连接被重置/],
    ['UND_ERR_CONNECT_TIMEOUT', /连接超时/],
    ['ERR_INVALID_URL', /URL 非法/],
  ];
  for (const [code, re] of cases) {
    const msg = describeNetworkError(failWith(code));
    assert.match(msg, re, `${code} 应给出可读原因，实际：${msg}`);
  }
});

test('#85 超时必须带时长（区分「站点慢」与「连接被拒」）', () => {
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  assert.match(describeNetworkError(abort, 15000), /请求超时（>15000ms）/, '超时要写清时长');
  assert.match(describeNetworkError(abort), /中断|超时/, '无时长时也要说清是中断/超时');
});

test('#85 未知错误也要保留原始 code（不吞信息）', () => {
  const msg = describeNetworkError(failWith('ESOMETHING_NEW'));
  assert.match(msg, /ESOMETHING_NEW/, `未知 code 必须原样带出：${msg}`);
});
