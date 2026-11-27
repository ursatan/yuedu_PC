/**
 * `#780` ③ / `#784` 回归锁：封面失败**采样**日志。
 *
 * 锁五件事（`#784` 用户点名的口径）：
 *  1. 2xx 不打印（拿得到状态码且 <400 一律不记）；
 *  2. 超时打印 `status=-`（连接/响应头/响应体超时没有状态码）；
 *  3. 显式 500 打印 `status=500`；
 *  4. 同 host 60s 内超过 5 条被限流（洪峰不刷屏，窗口滑出后恢复）；
 *  5. `cover≠1` 一律不打印。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCoverFailureSampler,
  formatCoverFailure,
  hostOf,
  isTimeoutLikeError,
  shouldNoteCoverFailure,
} from '../proxy-failure-log';

test('hostOf：域名/IP/端口保留，非法 URL 给空串', () => {
  assert.equal(hostOf('https://s3.go2778.com/static/tobeimg/x'), 's3.go2778.com');
  assert.equal(hostOf('http://104.17.0.1/static/a.jpg'), '104.17.0.1');
  assert.equal(hostOf('not a url'), '');
});

test('shouldNoteCoverFailure：cover≠1 一律不打印', () => {
  // 无论是否抛错、状态码多少，非封面请求都不进这个桶
  assert.equal(shouldNoteCoverFailure({ cover: undefined, status: 500, hasError: true }), false);
  assert.equal(shouldNoteCoverFailure({ cover: '0', status: 500, hasError: true }), false);
  assert.equal(shouldNoteCoverFailure({ cover: 'true', status: undefined, hasError: true }), false);
  // 字符串以外的形态（query 数组）同样不算
  assert.equal(shouldNoteCoverFailure({ cover: ['1'], status: 500, hasError: true }), false);
});

test('shouldNoteCoverFailure：2xx 不打印（不是失败）', () => {
  assert.equal(shouldNoteCoverFailure({ cover: '1', status: 200, hasError: false }), false);
  assert.equal(shouldNoteCoverFailure({ cover: '1', status: 204, hasError: true }), false);
  assert.equal(shouldNoteCoverFailure({ cover: '1', status: 301, hasError: false }), false);
});

test('shouldNoteCoverFailure：显式 500/429 打印；无状态码只有抛错才打印', () => {
  assert.equal(shouldNoteCoverFailure({ cover: '1', status: 500, hasError: false }), true);
  assert.equal(shouldNoteCoverFailure({ cover: '1', status: 429, hasError: false }), true);
  // 超时/连接失败：拿不到状态码，靠 hasError
  assert.equal(shouldNoteCoverFailure({ cover: '1', status: undefined, hasError: true }), true);
  // 既没有状态码也没有错误 → 不是失败
  assert.equal(shouldNoteCoverFailure({ cover: '1', status: undefined, hasError: false }), false);
});

test('formatCoverFailure：超时记 status=- timeout=1，显式 500 记 status=500', () => {
  const timeout = formatCoverFailure({
    host: 's3.go2778.com',
    timedOut: true,
    ms: 20003,
    url: 'https://s3.go2778.com/static/tobeimg/aaa/rs:fill:300:400:0/g:sm/bbb',
  });
  assert.match(timeout, /^\[proxy-fail\] host=s3\.go2778\.com status=- timeout=1 cover=1 breaker=exempt ms=20003 u=/);

  const explicit = formatCoverFailure({ host: 'x.test', status: 500, timedOut: false, ms: 8, url: 'https://x.test/a' });
  assert.match(explicit, /status=500 timeout=0 cover=1 breaker=exempt ms=8 u=/);

  const rateLimited = formatCoverFailure({ host: 'x.test', status: 429, timedOut: false, ms: 8, url: 'https://x.test/a' });
  assert.match(rateLimited, /status=429 timeout=0 cover=1 breaker=exempt ms=8 u=/);
});

test('sampler：每 host 60s 内第 6 条起被限流；窗口滑出后恢复；不同 host 独立', () => {
  let now = 0;
  const s = createCoverFailureSampler({ now: () => now });
  const mk = (host: string) => ({ host, status: 429, timedOut: false, ms: 10, url: `https://${host}/a` });
  const lines = Array.from({ length: 7 }, () => s.note(mk('s3.go2778.com')));
  assert.equal(lines.filter(Boolean).length, 5);
  assert.equal(lines[5], null);
  assert.equal(lines[6], null);
  // 另一个 host 不受影响
  assert.ok(s.note(mk('storage-b.picacomic.com')));
  // 60s 后窗口清空
  now = 60_001;
  assert.ok(s.note(mk('s3.go2778.com')));
});

test('isTimeoutLikeError：覆盖 core/undici/中文，普通错误不算', () => {
  assert.equal(isTimeoutLikeError({ code: 'BODY_DEADLINE' }), true);
  assert.equal(isTimeoutLikeError({ code: 'UND_ERR_HEADERS_TIMEOUT' }), true);
  assert.equal(isTimeoutLikeError(new Error('请求超时（>20000ms）')), true);
  assert.equal(isTimeoutLikeError(new Error('ECONNRESET')), false);
  assert.equal(isTimeoutLikeError(new Error('HTTP 429')), false);
});

test('端到端（纯函数串联）：cover=1 + 超时 → 打出 status=- 的真行；2xx/cover≠1 → 一行都不出', () => {
  const s = createCoverFailureSampler({ now: () => 0 });
  const gate = { cover: '1' as unknown };
  const timeoutErr = new Error('请求超时（>20000ms）');

  const line = shouldNoteCoverFailure({ ...gate, hasError: true })
    ? s.note({ host: 's3.go2778.com', timedOut: isTimeoutLikeError(timeoutErr), ms: 20003, url: 'https://s3.go2778.com/x' })
    : null;
  assert.match(String(line), /status=- timeout=1 cover=1/);

  // cover≠1：即使抛错、即使本 host 还有配额，也不打印
  assert.equal(shouldNoteCoverFailure({ cover: '0', hasError: true }), false);
  // 2xx：状态码路径直接拒绝
  assert.equal(shouldNoteCoverFailure({ cover: '1', status: 200, hasError: false }), false);
});
