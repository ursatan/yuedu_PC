/**
 * `#636` 第二层回归锁：**外部脚本取数的「重试 + 预算」**（`Reload()` / `java.importScript` /
 * `java.cacheFile` 的共用判据）。
 *
 * ## 为什么要锁
 * 源作者把公共函数写在**外链** `jsLib` 里（qyyuapi 系 14~20 源），其中
 * ```js
 * function Reload(e) { …; return String(java.importScript(e)); }
 * ```
 * ⇒ 一次取数失败就直接决定「该源所有规则是否全挂」，而这类主机慢且抖
 * （实测 `loginUrl.js` GET 0.3~2.9s、`jsLib.js` 4~9s、HEAD 一次 25s 未返回）。
 *
 * 旧实现：单次尝试 + 失败即空 ⇒ `内容获取失败或者为空`（分不清超时/DNS/404）。
 * 新实现（`js-file.ts`）：
 *   · 4xx **不重试**（确定性失败，重试只是白等）
 *   · `code=0` / 5xx / 空 body ⇒ 重试（最多 3 次，退避 300/800ms）
 *   · 单次 20s、总预算 45s
 *   · 全失败时把每次的原因拼进错误信息（可定位）
 *
 * ⚠️ 这里**只锁策略本身**（纯函数 + 可注入的 `fetchOnce`），不打网络。
 * 端到端效果见 `docs/rounds/2026-10-26-10-*.md`（包子漫画/漫画柜/G站实测）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchScriptTextRetry,
  isBlankScriptBody,
  isTransientScriptFetchError,
  scriptFetchBackoffMs,
  shouldRetryScriptFetch,
  SCRIPT_FETCH_POLICY,
  type ScriptFetchAttempt,
  type ScriptFetchPolicy,
} from '../selector/js-file';

/** 小预算策略：让重试相关用例跑得快，又不改变判据 */
const FAST: ScriptFetchPolicy = { maxAttempts: 3, perAttemptMs: 1_000, totalBudgetMs: 10_000 };

test('shouldRetryScriptFetch：4xx 不重试，其它瞬时失败都重试', () => {
  // 确定性失败：站点明确说「没有/不给」
  assert.equal(shouldRetryScriptFetch(404, '<html>404 Not Found</html>'), false);
  assert.equal(shouldRetryScriptFetch(403, 'forbidden'), false);
  // 传输层失败（拿不到状态码）、5xx、空 body ⇒ 抖动，值得再试
  assert.equal(shouldRetryScriptFetch(0, ''), true);
  assert.equal(shouldRetryScriptFetch(502, 'bad gateway'), true);
  assert.equal(shouldRetryScriptFetch(200, ''), true);
  assert.equal(shouldRetryScriptFetch(200, '   \n\t '), true);
  // 正常内容 ⇒ 不是失败
  assert.equal(shouldRetryScriptFetch(200, 'var a=1'), false);
});

test('isBlankScriptBody：纯空白等价于空（对齐上游 isBlank）', () => {
  assert.equal(isBlankScriptBody(''), true);
  assert.equal(isBlankScriptBody('  \r\n\t '), true);
  assert.equal(isBlankScriptBody(undefined), true);
  assert.equal(isBlankScriptBody(null), true);
  assert.equal(isBlankScriptBody('0'), false);
  assert.equal(isBlankScriptBody(';'), false);
});

test('isTransientScriptFetchError：超时/连接类重试，HTTP 4xx 不重试', () => {
  assert.equal(isTransientScriptFetchError(new Error('This operation was aborted')), true);
  assert.equal(isTransientScriptFetchError(new Error('fetch failed')), true);
  assert.equal(isTransientScriptFetchError(new Error('connect ECONNRESET 1.2.3.4:443')), true);
  assert.equal(isTransientScriptFetchError(new Error('getaddrinfo EAI_AGAIN qyyuapi.com')), true);
  assert.equal(isTransientScriptFetchError(new Error('jsLib 下载超时（>20000ms）')), true);
  assert.equal(isTransientScriptFetchError(new Error('HTTP 404 / body 138B')), false);
  assert.equal(isTransientScriptFetchError(new Error('Malformed URL: x')), false);
});

test('scriptFetchBackoffMs：第一次 300ms，之后 800ms', () => {
  assert.equal(scriptFetchBackoffMs(1), 300);
  assert.equal(scriptFetchBackoffMs(2), 800);
  assert.equal(scriptFetchBackoffMs(3), 800);
});

test('fetchScriptTextRetry：首次成功 ⇒ 只请求一次', async () => {
  let calls = 0;
  const r = await fetchScriptTextRetry(async () => {
    calls += 1;
    return { text: 'var a=1', code: 200 };
  }, FAST);
  assert.equal(calls, 1);
  assert.equal(r.text, 'var a=1');
  assert.equal(r.attempts, 1);
  assert.equal(r.failure, '');
});

test('fetchScriptTextRetry：空 body 后重试成功（★ 线上最常见的形态）', async () => {
  const seq: ScriptFetchAttempt[] = [
    { text: '', code: 0, error: 'fetch failed' },
    { text: '', code: 0, error: 'fetch failed' },
    { text: 'function Get(e){return 1}', code: 200 },
  ];
  let i = 0;
  const r = await fetchScriptTextRetry(async () => seq[i++]!, FAST);
  assert.equal(r.attempts, 3);
  assert.equal(r.text, 'function Get(e){return 1}');
  assert.equal(r.failure, '');
});

test('fetchScriptTextRetry：4xx 立即收手（不再白等）', async () => {
  let calls = 0;
  const r = await fetchScriptTextRetry(async () => {
    calls += 1;
    return { text: '', code: 404 };
  }, FAST);
  assert.equal(calls, 1, '404 是确定性失败，只应尝试一次');
  assert.equal(r.text, '');
  assert.match(r.failure, /HTTP 404/);
});

test('fetchScriptTextRetry：404 但**有内容**（nginx 错误页）按成功返回 —— 与上游同语义', async () => {
  // 上游 importScript 判的是「内容空不空」，不是状态码；138B 的 nginx 404 页也算「拿到了」，
  // 于是源里的 eval 会在下一层炸出可见的 SyntaxError（而不是伪装成「空」）。
  let calls = 0;
  const r = await fetchScriptTextRetry(async () => {
    calls += 1;
    return { text: '<html>404 Not Found</html>', code: 404 };
  }, FAST);
  assert.equal(calls, 1);
  assert.equal(r.code, 404);
  assert.match(r.text, /404 Not Found/);
});

test('fetchScriptTextRetry：全部失败 ⇒ failure 里逐次记原因', async () => {
  const r = await fetchScriptTextRetry(async () => ({ text: '', code: 0, error: 'aborted' }), FAST);
  assert.equal(r.text, '');
  assert.equal(r.attempts, 3);
  assert.match(r.failure, /第 1 次/);
  assert.match(r.failure, /第 3 次/);
});

test('fetchScriptTextRetry：不可重试的异常（4xx 语义）只尝试一次', async () => {
  let calls = 0;
  const r = await fetchScriptTextRetry(async () => {
    calls += 1;
    throw new Error('HTTP 410 Gone');
  }, FAST);
  assert.equal(calls, 1);
  assert.match(r.failure, /HTTP 410/);
});

test('fetchScriptTextRetry：可重试的异常（ECONNRESET）会再试', async () => {
  let calls = 0;
  const r = await fetchScriptTextRetry(async () => {
    calls += 1;
    if (calls === 1) throw new Error('read ECONNRESET');
    return { text: 'ok', code: 200 };
  }, FAST);
  assert.equal(calls, 2);
  assert.equal(r.text, 'ok');
});

test('fetchScriptTextRetry：总预算用尽即停（不会无限拖）', async () => {
  let calls = 0;
  const r = await fetchScriptTextRetry(
    async () => {
      calls += 1;
      await new Promise<void>((res) => setTimeout(res, 600));
      return { text: '', code: 0 };
    },
    { maxAttempts: 5, perAttemptMs: 1_000, totalBudgetMs: 1_500 },
  );
  assert.ok(calls <= 2, `预算 1500ms / 每次 600ms ⇒ 最多 2 次，实际 ${calls}`);
  assert.match(r.failure, /预算用尽/);
});

test('fetchScriptTextRetry：单次超时按剩余预算收窄，且不超过 perAttemptMs', async () => {
  const seen: number[] = [];
  await fetchScriptTextRetry(async (timeoutMs) => {
    seen.push(timeoutMs);
    return { text: 'x', code: 200 };
  }, FAST);
  assert.deepEqual(seen, [FAST.perAttemptMs], '首试应拿到 perAttemptMs');
});

test('默认策略的数字是「实测支撑」的（改动请同步 docs/rounds/2026-10-26-10）', () => {
  assert.equal(SCRIPT_FETCH_POLICY.maxAttempts, 3);
  assert.equal(SCRIPT_FETCH_POLICY.perAttemptMs, 20_000);
  assert.equal(SCRIPT_FETCH_POLICY.totalBudgetMs, 45_000);
});
